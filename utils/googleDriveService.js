import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

class GoogleDriveService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      process.env.GOOGLE_DRIVE_REDIRECT_URI || 'http://localhost:5000/auth/google/callback'
    );

    // ✅ Set both access_token and refresh_token
    this.oauth2Client.setCredentials({
      access_token: process.env.GOOGLE_ACCESS_TOKEN,
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    });

    this.drive = google.drive({
      version: 'v3',
      auth: this.oauth2Client
    });

    // ✅ Handle automatic token refresh
    this.oauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
      }
      if (tokens.access_token) {
        // Optionally save to .env programmatically
        this.updateEnvToken('GOOGLE_ACCESS_TOKEN', tokens.access_token);
      }
    });

    // ✅ Cache for location folders to avoid repeated API calls
    this.locationFolderCache = new Map();

    // ✅ Validate configuration on startup
    this.validateConfiguration();
  }

  /**
   * ✅ NEW: Validate OAuth configuration
   */
  validateConfiguration() {
    const requiredEnvVars = [
      'GOOGLE_DRIVE_CLIENT_ID',
      'GOOGLE_DRIVE_CLIENT_SECRET',
      'GOOGLE_DRIVE_FOLDER_ID',
      'GOOGLE_ACCESS_TOKEN',
      'GOOGLE_DRIVE_REFRESH_TOKEN'
    ];

    const missing = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missing.length > 0) {
      throw new Error(`Missing Google Drive configuration: ${missing.join(', ')}`);
    }
  }

  /**
   * ✅ NEW: Update environment token (optional - for automatic token updates)
   */
  updateEnvToken(tokenName, tokenValue) {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        const tokenRegex = new RegExp(`^${tokenName}=.*`, 'm');
        
        if (tokenRegex.test(envContent)) {
          envContent = envContent.replace(tokenRegex, `${tokenName}=${tokenValue}`);
        } else {
          envContent += `\n${tokenName}=${tokenValue}`;
        }
        
        fs.writeFileSync(envPath, envContent);
      }
    } catch (error) {
    }
  }

  /**
   * ✅ ENHANCED: Retry mechanism for API calls with authentication handling
   */
  async executeWithRetry(operation, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Handle specific authentication errors
        if (error.message.includes('invalid_grant') || 
            error.message.includes('invalid_token') ||
            error.code === 401) {
          
          if (attempt < maxRetries) {
            try {
              await this.oauth2Client.refreshAccessToken();
              continue;
            } catch (refreshError) {
              throw new Error('Authentication failed - please re-authenticate your Google Drive access');
            }
          }
        }

        // Handle rate limiting (429 errors)
        if (error.code === 429 && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // If not retryable or max retries reached, break
        if (attempt === maxRetries) {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * ✅ ENHANCED: Create or get location folder with improved error handling
   */
  async getLocationFolder(locationName) {
    // Check cache first
    if (this.locationFolderCache.has(locationName)) {
      return this.locationFolderCache.get(locationName);
    }

    return await this.executeWithRetry(async () => {
      try {
        // Search for existing location folder
        const searchResponse = await this.drive.files.list({
          q: `name='${locationName.replace(/'/g, "\\'")}' and '${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id,name)',
          pageSize: 1
        });

        let folderId;

        if (searchResponse.data.files && searchResponse.data.files.length > 0) {
          // Folder exists, use it
          folderId = searchResponse.data.files[0].id;
        } else {
          // Create new location folder
          const folderMetadata = {
            name: locationName,
            parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            mimeType: 'application/vnd.google-apps.folder',
            description: `Documents for ${locationName} location - Created ${new Date().toISOString()}`
          };

          const createResponse = await this.drive.files.create({
            resource: folderMetadata,
            fields: 'id,name'
          });

          folderId = createResponse.data.id;
        }

        // Cache the folder ID
        this.locationFolderCache.set(locationName, folderId);
        return folderId;

      } catch (error) {
        // Fallback to main folder if location folder creation fails
        return process.env.GOOGLE_DRIVE_FOLDER_ID;
      }
    });
  }

  /**
   * ✅ ENHANCED: Upload file with comprehensive error handling
   */
  async uploadFile(fileData, employeeId, locationName = 'General') {
    return await this.executeWithRetry(async () => {
      try {
        const { originalname, path: tempPath, mimetype, size } = fileData;
        
        // Validate file exists
        if (!fs.existsSync(tempPath)) {
          throw new Error(`File not found: ${tempPath}`);
        }

        // ✅ Get location-specific folder
        const locationFolderId = await this.getLocationFolder(locationName);
        
        const fileExtension = path.extname(originalname);
        const uniqueFilename = `${employeeId}-${uuidv4()}${fileExtension}`;

        const fileMetadata = {
          name: uniqueFilename,
          parents: [locationFolderId],
          description: `Document for employee ${employeeId} (${locationName} location) - Uploaded ${new Date().toISOString()}`,
        };

        const media = {
          mimeType: mimetype,
          body: fs.createReadStream(tempPath),
        };
        const response = await this.drive.files.create({
          resource: fileMetadata,
          media: media,
          fields: 'id,name,size,mimeType,createdTime,webViewLink,webContentLink,parents'
        });

        // Clean up temp file
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        return {
          googleDriveId: response.data.id,
          originalName: originalname,
          filename: uniqueFilename,
          mimeType: mimetype,
          size: parseInt(size) || response.data.size,
          webViewLink: response.data.webViewLink,
          webContentLink: response.data.webContentLink,
          uploadedAt: new Date(),
          createdTime: response.data.createdTime,
          locationName: locationName,
          locationFolderId: locationFolderId
        };
      } catch (error) {
        // Clean up temp file on error
        if (fileData.path && fs.existsSync(fileData.path)) {
          fs.unlinkSync(fileData.path);
        }
        throw new Error(`Google Drive upload failed: ${error.message}`);
      }
    });
  }

  /**
   * ✅ ENHANCED: Upload multiple files with concurrent processing
   */
  async uploadMultipleFiles(files, employeeId, locationName = 'General') {
    if (!files || files.length === 0) {
      return [];
    }
    // Process files concurrently but limit concurrency to avoid rate limiting
    const maxConcurrent = 3;
    const results = [];
    
    for (let i = 0; i < files.length; i += maxConcurrent) {
      const batch = files.slice(i, i + maxConcurrent);
      const batchPromises = batch.map(file => 
        this.uploadFile(file, employeeId, locationName)
          .catch(error => {
            return { error: error.message, originalName: file.originalname };
          })
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Add small delay between batches to avoid rate limiting
      if (i + maxConcurrent < files.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    const successful = results.filter(r => !r.error);
    const failed = results.filter(r => r.error);
    if (failed.length > 0) {
    }
    
    return successful;
  }

  /**
   * ✅ ENHANCED: Get location folders with error handling
   */
  async getLocationFolders() {
    return await this.executeWithRetry(async () => {
      try {
        const response = await this.drive.files.list({
          q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id,name,createdTime,modifiedTime)',
          orderBy: 'name',
          pageSize: 1000
        });
        return response.data.files || [];
      } catch (error) {
        return [];
      }
    });
  }

  /**
   * ✅ ENHANCED: Get files in location with pagination support
   */
  async getLocationFiles(locationName, limit = 100, pageToken = null) {
    return await this.executeWithRetry(async () => {
      try {
        const locationFolderId = await this.getLocationFolder(locationName);
        
        const queryParams = {
          q: `'${locationFolderId}' in parents and trashed=false`,
          fields: 'nextPageToken,files(id,name,size,createdTime,modifiedTime,mimeType)',
          pageSize: limit,
          orderBy: 'createdTime desc'
        };

        if (pageToken) {
          queryParams.pageToken = pageToken;
        }

        const response = await this.drive.files.list(queryParams);

        return {
          files: response.data.files || [],
          nextPageToken: response.data.nextPageToken,
          locationName,
          locationFolderId
        };
      } catch (error) {
        return { files: [], nextPageToken: null, locationName, locationFolderId: null };
      }
    });
  }

  /**
   * ✅ ENHANCED: Get file metadata with retry logic
   */
  async getFileMetadata(fileId) {
    return await this.executeWithRetry(async () => {
      try {
        const response = await this.drive.files.get({
          fileId: fileId,
          fields: 'id,name,size,mimeType,createdTime,modifiedTime,webViewLink,webContentLink,parents,permissions,description'
        });
        return response.data;
      } catch (error) {
        throw new Error(`Failed to get file metadata: ${error.message}`);
      }
    });
  }

  /**
   * ✅ ENHANCED: Generate shareable link with permission handling
   */
  async generateShareableLink(fileId) {
    return await this.executeWithRetry(async () => {
      try {
        // First, get file metadata
        const metadata = await this.getFileMetadata(fileId);
        
        if (metadata.webViewLink) {
          return metadata.webViewLink;
        }

        // Create public permission if needed
        try {
          await this.drive.permissions.create({
            fileId: fileId,
            resource: {
              role: 'reader',
              type: 'anyone'
            }
          });
        } catch (permError) {
        }

        // Return constructed Google Drive view link
        const shareableLink = `https://drive.google.com/file/d/${fileId}/view`;
        return shareableLink;
        
      } catch (error) {
        throw new Error(`Failed to generate shareable link: ${error.message}`);
      }
    });
  }

  /**
   * ✅ ENHANCED: Download file with stream support
   */
  async downloadFile(fileId) {
    return await this.executeWithRetry(async () => {
      try {
        const response = await this.drive.files.get({
          fileId: fileId,
          alt: 'media'
        }, {
          responseType: 'stream'
        });
        return response.data;
        
      } catch (error) {
        throw new Error(`Failed to download file: ${error.message}`);
      }
    });
  }

  /**
   * ✅ ENHANCED: Create download link with permission handling
   */
  async createDownloadLink(fileId) {
    return await this.executeWithRetry(async () => {
      try {
        // Get file metadata first
        const metadata = await this.getFileMetadata(fileId);
        
        if (metadata.webContentLink) {
          return metadata.webContentLink;
        }

        // Ensure public permission exists
        try {
          await this.drive.permissions.create({
            fileId: fileId,
            resource: {
              role: 'reader',
              type: 'anyone'
            }
          });
        } catch (permError) {
        }

        // Return constructed download link
        const downloadLink = `https://drive.google.com/uc?export=download&id=${fileId}`;
        return downloadLink;
        
      } catch (error) {
        throw new Error(`Failed to create download link: ${error.message}`);
      }
    });
  }

  /**
   * ✅ ENHANCED: Delete file with confirmation
   */
  async deleteFile(fileId) {
    return await this.executeWithRetry(async () => {
      try {
        // Get file info before deletion for logging
        let fileName = 'Unknown';
        try {
          const metadata = await this.getFileMetadata(fileId);
          fileName = metadata.name;
        } catch (metaError) {
          // Continue with deletion even if metadata fetch fails
        }

        await this.drive.files.delete({
          fileId: fileId
        });
        return { success: true, fileName, fileId };
      } catch (error) {
        throw new Error(`Google Drive delete failed: ${error.message}`);
      }
    });
  }

  /**
   * ✅ NEW: Batch delete files
   */
  async deleteMultipleFiles(fileIds) {
    if (!fileIds || fileIds.length === 0) {
      return [];
    }
    const results = [];

    // Process deletions in batches to avoid rate limiting
    for (const fileId of fileIds) {
      try {
        const result = await this.deleteFile(fileId);
        results.push(result);
        // Small delay between deletions
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        results.push({ success: false, fileId, error: error.message });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    return results;
  }

  /**
   * ✅ NEW: Health check method
   */
  async healthCheck() {
    try {
      // Test basic API access
      const response = await this.drive.files.list({
        pageSize: 1,
        fields: 'files(id)'
      });

      const isHealthy = response && response.data;
      return {
        healthy: isHealthy,
        timestamp: new Date().toISOString(),
        service: 'Google Drive API',
        hasValidTokens: !!(process.env.GOOGLE_ACCESS_TOKEN && process.env.GOOGLE_DRIVE_REFRESH_TOKEN)
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        service: 'Google Drive API'
      };
    }
  }
}

export default new GoogleDriveService();
