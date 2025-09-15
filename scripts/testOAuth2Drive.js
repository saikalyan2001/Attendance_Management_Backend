// scripts/testOAuth2Drive.js
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

async function testOAuth2Drive() {
  try {
    
    
    // Check required environment variables
    const requiredVars = [
      'GOOGLE_DRIVE_CLIENT_ID',
      'GOOGLE_DRIVE_CLIENT_SECRET', 
      'GOOGLE_DRIVE_REFRESH_TOKEN',
      'GOOGLE_DRIVE_REDIRECT_URI'
    ];
    
    for (const varName of requiredVars) {
      if (!process.env[varName]) {
        throw new Error(`Missing environment variable: ${varName}`);
      }
    }
    
    
    
    // Initialize OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      process.env.GOOGLE_DRIVE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    });

    // Test token refresh
    
    const { credentials } = await oauth2Client.refreshAccessToken();
    
    
    
    // Test Drive API access
    
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    // Get user info
    const aboutResponse = await drive.about.get({ fields: 'user' });
    
    
    
    // Test folder access (if you have GOOGLE_DRIVE_FOLDER_ID set)
    if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
      
      
      try {
        const folder = await drive.files.get({
          fileId: process.env.GOOGLE_DRIVE_FOLDER_ID,
          fields: 'id,name,parents'
        });
        
        
        
        
        
        // List files in folder
        const files = await drive.files.list({
          q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`,
          fields: 'files(id,name,size,createdTime)',
          pageSize: 10
        });
        
        
        files.data.files.forEach(file => {
          
        });
        
      } catch (folderError) {
                
      }
    }
    
    
    
  } catch (error) {
    
    
    if (error.message.includes('invalid_grant')) {
      
      
      
      
    }
  }
}

testOAuth2Drive();
