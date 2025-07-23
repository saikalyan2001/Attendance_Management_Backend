import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import seedAdmin from './seedAdmin.js';
import { protect, restrictTo } from './middleware/authMiddleware.js';
import authRoutes from './routes/auth.js';
import siteInchargeRoutes from './routes/siteincharge/Dashboard.js';
import siteInchargeAttendanceRoutes from './routes/siteincharge/attendance.js';
import siteInchargeEmployeeRoutes from './routes/siteincharge/employee.js';
import siteInchargeReportsRoutes from './routes/siteincharge/reports.js';
import siteInchargeProfileRoutes from './routes/siteincharge/profile.js';
import adminLocationsRoutes from './routes/admin/locations.js';
import adminSettingsRoutes from './routes/admin/settings.js';
import adminRoutes from './routes/admin/dashboard.js';
import reportsRoutes from './routes/admin/reports.js';
import attendanceRoutes from './routes/admin/attendance.js';
import employeesRoutes from './routes/admin/employees.js';
import profileRoutes from './routes/admin/profile.js';

dotenv.config();

const app = express();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'Uploads', 'documents');
fs.mkdir(uploadsDir, { recursive: true }).catch((err) => {
  console.error('Failed to create uploads directory:', err.message);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', protect, restrictTo('admin', 'siteincharge'), async (req, res, next) => {
  const decodedPath = decodeURIComponent(req.path);
  const filePath = path.join(__dirname, 'Uploads', 'documents', decodedPath.replace('/documents/', ''));
  console.log('Attempting to serve file:', filePath);
  try {
    await fs.access(filePath);
    express.static(uploadsDir)(req, res, next);
  } catch (err) {
    console.error('File access error:', err.message, 'Path:', filePath);
    res.status(404).json({ message: 'File not found' });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/siteincharge', siteInchargeRoutes);
app.use('/api/siteincharge', siteInchargeAttendanceRoutes);
app.use('/api/siteincharge', siteInchargeEmployeeRoutes);
app.use('/api/siteincharge', siteInchargeReportsRoutes);
app.use('/api/siteincharge', siteInchargeProfileRoutes);
app.use('/api/admin', adminLocationsRoutes);
app.use('/api/admin', adminSettingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', reportsRoutes);
app.use('/api/admin', attendanceRoutes);
app.use('/api/admin', employeesRoutes);
app.use('/api/admin', profileRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Start server and seed admin
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
    await seedAdmin();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
};

startServer();