import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String }, // Made optional to allow users without a password initially
  name: { type: String, required: true },
  phone: { type: String },
  role: { type: String, enum: ['admin', 'siteincharge', 'super_admin'], default: 'siteincharge' },
  locations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Location' }],
  profilePicture: {
    path: { type: String },
    uploadedAt: { type: Date },
  },
  resetPasswordToken: { type: String }, // New field for reset token
  resetPasswordExpires: { type: Date }, // New field for token expiration
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);