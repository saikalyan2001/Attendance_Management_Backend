import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

class GoogleDriveService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      process.env.GOOGLE_DRIVE_REDIRECT_URI
    );

    this.oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    });

    this.drive = google.drive({
      version: 'v3',
      auth: this.oauth2Client
    });

    // ✅ Cache for location folders to avoid repeated API calls
    this.locationFolderCache = new Map();
  }

  /**
   * ✅ NEW: Create or get location folder
   */
  async getLocationFolder(locationName) {
    // Check cache first
    if (this.locationFolderCache.has(locationName)) {
      return this.locationFolderCache.get(locationName);
    }

    try {
      // Search for existing location folder
      const searchResponse = await this.drive.files.list({
        q: `name='${locationName}' and '${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
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
          description: `Documents for ${locationName} location`
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
  }

  /**
   * ✅ ENHANCED: Upload file to location-specific folder
   */
  async uploadFile(fileData, employeeId, locationName = 'General') {
    try {
      const { originalname, path: tempPath, mimetype, size } = fileData;
      
      // ✅ Get location-specific folder
      const locationFolderId = await this.getLocationFolder(locationName);
      
      const fileExtension = path.extname(originalname);
      const uniqueFilename = `${employeeId}-${uuidv4()}${fileExtension}`;

      const fileMetadata = {
        name: uniqueFilename,
        parents: [locationFolderId], // ✅ Upload to location folder
        description: `Document for employee ${employeeId} (${locationName} location)`,
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

      fs.unlinkSync(tempPath);
      

      return {
        googleDriveId: response.data.id,
        originalName: originalname,
        filename: uniqueFilename,
        mimeType: mimetype,
        size: size,
        webViewLink: response.data.webViewLink,
        webContentLink: response.data.webContentLink,
        uploadedAt: new Date(),
        createdTime: response.data.createdTime,
        locationName: locationName, // ✅ Track which location folder
        locationFolderId: locationFolderId
      };
    } catch (error) {
      
      if (fs.existsSync(fileData.path)) {
        fs.unlinkSync(fileData.path);
      }
      throw new Error(`Google Drive upload failed: ${error.message}`);
    }
  }

  /**
   * ✅ ENHANCED: Upload multiple files to location-specific folder
   */
  async uploadMultipleFiles(files, employeeId, locationName = 'General') {
    
    const uploadPromises = files.map(file => this.uploadFile(file, employeeId, locationName));
    const results = await Promise.all(uploadPromises);
    
    return results;
  }

  /**
   * ✅ NEW: List all location folders
   */
  async getLocationFolders() {
    try {
      const response = await this.drive.files.list({
        q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id,name,createdTime)',
        orderBy: 'name'
      });

      return response.data.files || [];
    } catch (error) {
      
      return [];
    }
  }

  /**
   * ✅ NEW: Get files in specific location folder
   */
  async getLocationFiles(locationName, limit = 100) {
    try {
      const locationFolderId = await this.getLocationFolder(locationName);
      
      const response = await this.drive.files.list({
        q: `'${locationFolderId}' in parents and trashed=false`,
        fields: 'files(id,name,size,createdTime,modifiedTime)',
        pageSize: limit,
        orderBy: 'createdTime desc'
      });

      return response.data.files || [];
    } catch (error) {
      
      return [];
    }
  }

  // ✅ UPDATED: Enhanced getFileMetadata method
  async getFileMetadata(fileId) {
    try {
      const response = await this.drive.files.get({
        fileId: fileId,
        fields: 'id,name,size,mimeType,createdTime,modifiedTime,webViewLink,webContentLink,parents,permissions'
      });
      return response.data;
    } catch (error) {
      
      throw new Error(`Failed to get file metadata: ${error.message}`);
    }
  }

  // ✅ NEW: Generate shareable link method
  async generateShareableLink(fileId) {
    try {
      
      
      // First, get file metadata to check if it already has a webViewLink
      const metadata = await this.getFileMetadata(fileId);
      
      if (metadata.webViewLink) {
        
        return metadata.webViewLink;
      }

      // If no webViewLink, create public permission
      
      
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
  }

  // ✅ NEW: Download file method
  async downloadFile(fileId) {
    try {
      
      
      const response = await this.drive.files.get({
        fileId: fileId,
        alt: 'media' // This tells Drive API to return file content, not metadata
      }, {
        responseType: 'stream' // Return as stream for better handling
      });
      
      
      return response.data;
      
    } catch (error) {
      
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }

  // ✅ NEW: Create download link method (alternative approach)
  async createDownloadLink(fileId) {
    try {
      
      
      // First check if file has webContentLink
      const metadata = await this.getFileMetadata(fileId);
      
      if (metadata.webContentLink) {
        
        return metadata.webContentLink;
      }

      // If no webContentLink, ensure public permission exists
      
      
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
  }

  // ✅ Keep existing deleteFile method
  async deleteFile(fileId) {
    try {
      await this.drive.files.delete({
        fileId: fileId
      });
      
    } catch (error) {
      
      throw new Error(`Google Drive delete failed: ${error.message}`);
    }
  }
}

export default new GoogleDriveService();
