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
      ('MongoDB connected for seeding');
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

    // Validate required environment variables
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      ('❌ ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment variables');
      throw new Error('Missing required environment variables');
    }

    // Check for existing admin
    const existingAdmin = await User.findOne({ email: adminData.email });

    if (existingAdmin) {
      (`🔁 Admin user exists: ${adminData.email}, updating password...`);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(adminData.password, salt);

      const result = await User.updateOne(
        { email: adminData.email },
        { $set: { password: hashedPassword, name: adminData.name, phone: adminData.phone } }
      );

      if (result.modifiedCount === 0) {
        console.warn('⚠️ No changes made to admin user (possibly same password or data)');
      } else {
        ('✅ Admin user updated successfully');
      }
      return;
    }

    // Create new admin user
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminData.password, salt);

    const admin = new User({
      ...adminData,
      password: hashedPassword,
    });

    await admin.save();
    ('✅ Admin user created successfully:', adminData.email);
  } catch (error) {
    ('❌ Error seeding admin:', error.message);
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