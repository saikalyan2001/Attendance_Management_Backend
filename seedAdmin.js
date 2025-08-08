import mongoose from 'mongoose';
import crypto from 'crypto';
import sgMail from '@sendgrid/mail';
import User from './models/User.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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
      name: process.env.ADMIN_NAME || 'Admin User',
      phone: process.env.ADMIN_PHONE || '1234567890',
      role: 'admin',
      locations: [],
      resetPasswordToken: crypto.randomBytes(20).toString('hex'),
      resetPasswordExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    };

    // Super Admin user data from environment variables
    const superAdminData = {
      email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@gmail.com',
      name: process.env.SUPER_ADMIN_NAME || 'Super Admin',
      phone: process.env.SUPER_ADMIN_PHONE || '0987654321',
      role: 'super_admin',
      locations: [],
      resetPasswordToken: crypto.randomBytes(20).toString('hex'),
      resetPasswordExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    };

    // Validate required environment variables
    if (!process.env.ADMIN_EMAIL) {
      console.error('❌ ADMIN_EMAIL must be set in environment variables');
      throw new Error('Missing required admin environment variables');
    }
    if (!process.env.SUPER_ADMIN_EMAIL) {
      console.error('❌ SUPER_ADMIN_EMAIL must be set in environment variables');
      throw new Error('Missing required super admin environment variables');
    }

    // Check for existing admin
    const existingAdmin = await User.findOne({ email: adminData.email });
    if (existingAdmin) {
      console.log(`🔁 Admin user exists: ${adminData.email}, updating data and sending new reset link...`);
      const resetPasswordToken = crypto.randomBytes(20).toString('hex');
      const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const result = await User.updateOne(
        { email: adminData.email },
        {
          $set: {
            name: adminData.name,
            phone: adminData.phone,
            resetPasswordToken,
            resetPasswordExpires,
            password: undefined, // Clear password to enforce reset
          },
        }
      );

      if (result.modifiedCount === 0) {
        console.warn('⚠️ No changes made to admin user');
      } else {
        const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
        const msg = {
          to: adminData.email,
          from: process.env.FROM_EMAIL,
          subject: 'Set Up Your Admin Account',
          html: `
            <h1>Welcome, ${adminData.name}!</h1>
            <p>Your admin account has been updated.</p>
            <p><strong>Email:</strong> ${adminData.email}</p>
            <p><strong>Role:</strong> Admin</p>
            <p>Please click the link below to set your password:</p>
            <a href="${loginLink}">Set Your Password</a>
            <p>This link will expire in 24 hours.</p>
            <p><strong>Important:</strong> Do not share this link with anyone.</p>
          `,
        };

        try {
          await sgMail.send(msg);
          console.log(`Password setup link sent to ${adminData.email}`);
        } catch (emailError) {
          console.error('Error sending admin email:', emailError);
        }
        console.log('✅ Admin user updated successfully');
      }
    } else {
      const admin = new User(adminData);
      await admin.save();
      const loginLink = `${process.env.APP_URL}/set-password?token=${adminData.resetPasswordToken}`;
      const msg = {
        to: adminData.email,
        from: process.env.FROM_EMAIL,
        subject: 'Set Up Your Admin Account',
        html: `
          <h1>Welcome, ${adminData.name}!</h1>
          <p>Your admin account has been created successfully.</p>
          <p><strong>Email:</strong> ${adminData.email}</p>
          <p><strong>Role:</strong> Admin</p>
          <p>Please click the link below to set your password:</p>
          <a href="${loginLink}">Set Your Password</a>
          <p>This link will expire in 24 hours.</p>
          <p><strong>Important:</strong> Do not share this link with anyone.</p>
        `,
      };

      try {
        await sgMail.send(msg);
        console.log(`Password setup link sent to ${adminData.email}`);
      } catch (emailError) {
        console.error('Error sending admin email:', emailError);
      }
      console.log('✅ Admin user created successfully:', adminData.email);
    }

    // Check for existing super admin
    const existingSuperAdmin = await User.findOne({ email: superAdminData.email });
    if (existingSuperAdmin) {
      console.log(`🔁 Super Admin user exists: ${superAdminData.email}, updating data and sending new reset link...`);
      const resetPasswordToken = crypto.randomBytes(20).toString('hex');
      const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const result = await User.updateOne(
        { email: superAdminData.email },
        {
          $set: {
            name: superAdminData.name,
            phone: superAdminData.phone,
            resetPasswordToken,
            resetPasswordExpires,
            password: undefined, // Clear password to enforce reset
          },
        }
      );

      if (result.modifiedCount === 0) {
        console.warn('⚠️ No changes made to super admin user');
      } else {
        const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
        const msg = {
          to: superAdminData.email,
          from: process.env.FROM_EMAIL,
          subject: 'Set Up Your Super Admin Account',
          html: `
            <h1>Welcome, ${superAdminData.name}!</h1>
            <p>Your super admin account has been updated.</p>
            <p><strong>Email:</strong> ${superAdminData.email}</p>
            <p><strong>Role:</strong> Super Admin</p>
            <p>Please click the link below to set your password:</p>
            <a href="${loginLink}">Set Your Password</a>
            <p>This link will expire in 24 hours.</p>
            <p><strong>Important:</strong> Do not share this link with anyone.</p>
          `,
        };

        try {
          await sgMail.send(msg);
          console.log(`Password setup link sent to ${superAdminData.email}`);
        } catch (emailError) {
          console.error('Error sending super admin email:', emailError);
        }
        console.log('✅ Super Admin user updated successfully');
      }
    } else {
      const superAdmin = new User(superAdminData);
      await superAdmin.save();
      const loginLink = `${process.env.APP_URL}/set-password?token=${superAdminData.resetPasswordToken}`;
      const msg = {
        to: superAdminData.email,
        from: process.env.FROM_EMAIL,
        subject: 'Set Up Your Super Admin Account',
        html: `
          <h1>Welcome, ${superAdminData.name}!</h1>
          <p>Your super admin account has been created successfully.</p>
          <p><strong>Email:</strong> ${superAdminData.email}</p>
          <p><strong>Role:</strong> Super Admin</p>
          <p>Please click the link below to set your password:</p>
          <a href="${loginLink}">Set Your Password</a>
          <p>This link will expire in 24 hours.</p>
          <p><strong>Important:</strong> Do not share this link with anyone.</p>
        `,
      };

      try {
        await sgMail.send(msg);
        console.log(`Password setup link sent to ${superAdminData.email}`);
      } catch (emailError) {
        console.error('Error sending super admin email:', emailError);
      }
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