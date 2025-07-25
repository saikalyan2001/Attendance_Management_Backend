import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, '../../Uploads');

async function ensureUploadsDir() {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
  } catch (error) {
    console.error('Error creating Uploads directory:', error.message);
    throw new Error('Failed to create Uploads directory');
  }
}

export const uploadFile = async (file) => {
  try {
    await ensureUploadsDir();
    const relativePath = `/Uploads/${file.filename}`;
    console.log('Uploaded file:', { path: file.path, filename: file.originalname });
    return { path: relativePath };
  } catch (error) {
    console.error('Upload file error:', error.message);
    throw new Error('Failed to process uploaded file');
  }
};

export const deleteFile = async (filePath) => {
  try {
    const absolutePath = path.join(__dirname, '../../', filePath);
    await fs.unlink(absolutePath);
    console.log('Deleted file:', absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Delete file error:', error.message);
      throw new Error('Failed to delete file');
    }
  }
};