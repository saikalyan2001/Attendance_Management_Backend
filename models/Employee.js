import mongoose from 'mongoose';

const employeeSchema = new mongoose.Schema({
  employeeId: {
    type: String,
    required: true,
    unique: true,
  },
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  designation: {
    type: String,
    required: true,
  },
  department: {
    type: String,
    required: true,
  },
  salary: {
    type: Number,
    required: true,
  },
  location: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
  },
  paidLeaves: {
    available: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    carriedForward: { type: Number, default: 0 },
  },
  documents: [
    {
      name: String,
      path: String,
      uploadedAt: Date,
    },
  ],
  phone: {
    type: String,
    match: [/^\d{10}$/, 'Phone number must be 10 digits'],
    required: false,
  },
  dob: {
    type: Date,
    required: false,
  },
}, { timestamps: true });

export default mongoose.model('Employee', employeeSchema);