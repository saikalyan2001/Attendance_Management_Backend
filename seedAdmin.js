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
    }

    // Super Admin user data from environment variables
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'superadmin@gmail.com';
    const superAdminName = process.env.SUPER_ADMIN_NAME || 'Super Admin';
    const superAdminPhone = process.env.SUPER_ADMIN_PHONE || '0987654321';

    if (!process.env.SUPER_ADMIN_EMAIL) {
      throw new Error('Missing required super admin environment variables');
    }

    // Check for existing super admin
    const existingSuperAdmin = await User.findOne({ email: superAdminEmail });
    
    if (existingSuperAdmin) {
  
      // Only send reset email if:
      // 1. User has no password AND no valid reset token
      // 2. User has no password AND reset token is expired
      const needsPasswordReset = !existingSuperAdmin.password && 
                                (!existingSuperAdmin.resetPasswordToken || 
                                 !existingSuperAdmin.resetPasswordExpires ||
                                 existingSuperAdmin.resetPasswordExpires <= new Date());
      
      
      if (needsPasswordReset) {
        
        const resetPasswordToken = crypto.randomBytes(20).toString('hex');
        const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);


        // Update the user with new reset token
        const updateData = {
          $set: {
            name: superAdminName,
            phone: superAdminPhone,
            resetPasswordToken,
            resetPasswordExpires,
          }
        };

        const result = await User.updateOne(
          { email: superAdminEmail },
          updateData
        );

   
        if (result.modifiedCount > 0) {
          const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
          
          const msg = {
            to: superAdminEmail,
            from: process.env.FROM_EMAIL,
            subject: 'Set Up Your Super Admin Account',
            html: `
              <h1>Welcome, ${superAdminName}!</h1>
              <p>Your super admin account needs password setup.</p>
              <p><strong>Email:</strong> ${superAdminEmail}</p>
              <p><strong>Role:</strong> Super Admin</p>
              <p>Please click the link below to set your password:</p>
              <a href="${loginLink}">Set Your Password</a>
              <p>This link will expire in 24 hours.</p>
              <p><strong>Important:</strong> Do not share this link with anyone.</p>
            `,
          };

          try {
            await sgMail.send(msg);
          } catch (emailError) {
          }
        }
      } else {
        
        // Update user details without changing password/token fields
        const updateData = {
          $set: {
            name: superAdminName,
            phone: superAdminPhone,
          }
        };

        await User.updateOne({ email: superAdminEmail }, updateData);
      }
    } else {
      // Create new super admin
      
      const resetPasswordToken = crypto.randomBytes(20).toString('hex');
      const resetPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      
      const superAdminData = {
        email: superAdminEmail,
        name: superAdminName,
        phone: superAdminPhone,
        role: 'super_admin',
        locations: [],
        resetPasswordToken,
        resetPasswordExpires,
      };

      const superAdmin = new User(superAdminData);
      const savedUser = await superAdmin.save();
            
      const loginLink = `${process.env.APP_URL}/set-password?token=${resetPasswordToken}`;
      
      const msg = {
        to: superAdminEmail,
        from: process.env.FROM_EMAIL,
        subject: 'Set Up Your Super Admin Account',
        html: `
          <h1>Welcome, ${superAdminName}!</h1>
          <p>Your super admin account has been created successfully.</p>
          <p><strong>Email:</strong> ${superAdminEmail}</p>
          <p><strong>Role:</strong> Super Admin</p>
          <p>Please click the link below to set your password:</p>
          <a href="${loginLink}">Set Your Password</a>
          <p>This link will expire in 24 hours.</p>
          <p><strong>Important:</strong> Do not share this link with anyone.</p>
        `,
      };

      try {
        await sgMail.send(msg);
      } catch (emailError) {
      }
    }

    
  } catch (error) {
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
    .catch((error) => {
      mongoose.connection.close();
      process.exit(1);
    });
}
