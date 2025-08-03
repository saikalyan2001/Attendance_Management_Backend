// src/backend/seedAdmin.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from './models/User.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const seedAdmin = async () => {
  try {
    // Ensure MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log('MongoDB connected for seeding');
    }

    // Admin user data from environment variables
    const adminData = {
      email: process.env.ADMIN_EMAIL || 'admin@gmail.com',
      password: process.env.ADMIN_PASSWORD || '123456',
      name: process.env.ADMIN_NAME || 'Admin User',
      phone: process.env.ADMIN_PHONE || '1234567890',
      role: 'admin',
      locations: [],
    };

    // Super Admin user data from environment variables
    const superAdminData = {
      email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@gmail.com',
      password: process.env.SUPER_ADMIN_PASSWORD || 'superadmin123',
      name: process.env.SUPER_ADMIN_NAME || 'Super Admin',
      phone: process.env.SUPER_ADMIN_PHONE || '0987654321',
      role: 'super_admin',
      locations: [],
    };

    // Validate required environment variables
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment variables');
      throw new Error('Missing required admin environment variables');
    }
    if (!process.env.SUPER_ADMIN_EMAIL || !process.env.SUPER_ADMIN_PASSWORD) {
      console.error('❌ SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in environment variables');
      throw new Error('Missing required super admin environment variables');
    }

    // Check for existing admin
    const existingAdmin = await User.findOne({ email: adminData.email });
    if (existingAdmin) {
      console.log(`🔁 Admin user exists: ${adminData.email}, updating password...`);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(adminData.password, salt);

      const result = await User.updateOne(
        { email: adminData.email },
        { $set: { password: hashedPassword, name: adminData.name, phone: adminData.phone } }
      );

      if (result.modifiedCount === 0) {
        console.warn('⚠️ No changes made to admin user (possibly same password or data)');
      } else {
        console.log('✅ Admin user updated successfully');
      }
    } else {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(adminData.password, salt);

      const admin = new User({
        ...adminData,
        password: hashedPassword,
      });

      await admin.save();
      console.log('✅ Admin user created successfully:', adminData.email);
    }

    // Check for existing super admin
    const existingSuperAdmin = await User.findOne({ email: superAdminData.email });
    if (existingSuperAdmin) {
      console.log(`🔁 Super Admin user exists: ${superAdminData.email}, updating password...`);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(superAdminData.password, salt);

      const result = await User.updateOne(
        { email: superAdminData.email },
        { $set: { password: hashedPassword, name: superAdminData.name, phone: superAdminData.phone } }
      );

      if (result.modifiedCount === 0) {
        console.warn('⚠️ No changes made to super admin user (possibly same password or data)');
      } else {
        console.log('✅ Super Admin user updated successfully');
      }
    } else {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(superAdminData.password, salt);

      const superAdmin = new User({
        ...superAdminData,
        password: hashedPassword,
      });

      await superAdmin.save();
      console.log('✅ Super Admin user created successfully:', superAdminData.email);
    }
  } catch (error) {
    console.error('❌ Error seeding users:', error.message);
    throw error;
  }
};

// Export for use in server.js
export default seedAdmin;

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedAdmin()
    .then(() => {
      mongoose.connection.close();
      process.exit(0);
    })
    .catch(() => {
      mongoose.connection.close();
      process.exit(1);
    });
}