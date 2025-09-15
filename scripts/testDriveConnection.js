// Update your scripts/testDriveConnection.js
import { google } from 'googleapis';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

async function testDriveConnection() {
  try {
    const credentials = JSON.parse(
      fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive']  // ✅ Use broader scope
    });

    const drive = google.drive({
      version: 'v3',
      auth: auth
    });

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    
    

    // ✅ Add supportsAllDrives parameter
    const folder = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,parents',
      supportsAllDrives: true  // ✅ This is crucial!
    });

    
    
    

    // Test file listing with supportsAllDrives
    const files = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: 'files(id, name)',
      supportsAllDrives: true,  // ✅ Also needed here
      includeItemsFromAllDrives: true  // ✅ Additional parameter
    });

    

  } catch (error) {
    
  }
}

testDriveConnection();
