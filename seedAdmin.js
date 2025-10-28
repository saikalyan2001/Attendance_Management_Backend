import mongoose from 'mongoose';
import User from './models/User.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const seedAdmin = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
    }

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'superadmin@gmail.com';
    const superAdminName = process.env.SUPER_ADMIN_NAME || 'Super Admin';
    const superAdminPhone = process.env.SUPER_ADMIN_PHONE || '0987654321';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin123';

    if (!process.env.SUPER_ADMIN_EMAIL) {
      console.warn('Warning: Using default super admin credentials. Set SUPER_ADMIN_EMAIL in .env');
    }

    const existingSuperAdmin = await User.findOne({ email: superAdminEmail });
    
    if (existingSuperAdmin) {
      console.log('Super admin already exists:', superAdminEmail);
      
      // Update details if needed (but not password to avoid overwriting)
      existingSuperAdmin.name = superAdminName;
      existingSuperAdmin.phone = superAdminPhone;
      await existingSuperAdmin.save();
      
      console.log('Super admin details updated successfully');
    } else {
      console.log('Creating new super admin...');
      
      const superAdmin = new User({
        email: superAdminEmail,
        name: superAdminName,
        phone: superAdminPhone,
        password: superAdminPassword,
        role: 'super_admin',
        locations: [],
      });

      await superAdmin.save();
      console.log('Super admin created successfully');
      console.log('Email:', superAdminEmail);
      console.log('Password:', superAdminPassword);
      console.log('IMPORTANT: Please change this password after first login!');
    }

    console.log('Seeding completed successfully');
  } catch (error) {
    console.error('Seeding error:', error);
    throw error;
  }
};

export default seedAdmin;

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedAdmin()
    .then(() => {
      console.log('Seeding process completed');
      mongoose.connection.close();
      process.exit(0);
    })
    .catch((error) => {
      console.error('Seeding process failed:', error);
      mongoose.connection.close();
      process.exit(1);
    });
}
