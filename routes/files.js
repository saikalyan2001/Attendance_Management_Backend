import express from 'express';
import googleDriveService from '../utils/googleDriveService.js';
import { protect, restrictTo } from '../middleware/authMiddleware.js';

const router = express.Router();

// Apply authentication
router.use(protect);
router.use(restrictTo('admin', 'siteincharge', 'super_admin'));

// Get file metadata
router.get('/:fileId/metadata', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    
    const metadata = await googleDriveService.getFileMetadata(fileId);
    res.json(metadata);
  } catch (error) {
    
    res.status(404).json({ message: 'File not found', error: error.message });
  }
});

// ✅ UPDATED: Download file with better error handling
router.get('/:fileId/download', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    
    // Get file metadata first
    const metadata = await googleDriveService.getFileMetadata(fileId);
    
    
    // Set appropriate headers
    res.setHeader('Content-Type', metadata.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.name}"`);
    res.setHeader('Content-Length', metadata.size || '');
    
    // Stream file content
    const fileStream = await googleDriveService.downloadFile(fileId);
    
    fileStream.on('error', (streamError) => {
      
      if (!res.headersSent) {
        res.status(500).json({ message: 'File stream error', error: streamError.message });
      }
    });
    
    fileStream.on('end', () => {
      
    });
    
    fileStream.pipe(res);
    
  } catch (error) {
    
    if (!res.headersSent) {
      res.status(404).json({ message: 'File download failed', error: error.message });
    }
  }
});

// ✅ UPDATED: View file with better error handling
router.get('/:fileId/view', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    
    const shareableLink = await googleDriveService.generateShareableLink(fileId);
    
    
    res.redirect(shareableLink);
  } catch (error) {
    
    res.status(404).json({ message: 'File not found', error: error.message });
  }
});

// ✅ NEW: Alternative direct link endpoint (for frontend fetch approach)
router.get('/:fileId/link', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { type = 'view' } = req.query; // 'view' or 'download'
    
    
    
    let link;
    if (type === 'download') {
      link = await googleDriveService.createDownloadLink(fileId);
    } else {
      link = await googleDriveService.generateShareableLink(fileId);
    }
    
    res.json({ 
      fileId, 
      type, 
      link,
      success: true 
    });
  } catch (error) {
    
    res.status(404).json({ 
      message: 'Failed to generate link', 
      error: error.message,
      success: false 
    });
  }
});

export default router;
