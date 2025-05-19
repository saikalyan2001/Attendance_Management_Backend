import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import authRoutes from './routes/auth.js';
import siteInchargeRoutes from './routes/siteincharge/dashboard.js';
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

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(path.resolve(), 'Uploads')));

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

mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));