import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const uploadFile = async (file) => {
  try {
    const filePath = path.join(__dirname, '../../uploads/', file.filename);
    return {
      path: `/uploads/${file.filename}`,
      filename: file.originalname,
    };
  } catch (error) {
    console.error('Upload file error:', error.message);
    throw new Error('Failed to process uploaded file');
  }
};

export const deleteFile = async (filePath) => {
  try {
    const absolutePath = path.join(__dirname, '../../', filePath);
    await fs.unlink(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Delete file error:', error.message);
      throw new Error('Failed to delete file');
    }
  }
};
