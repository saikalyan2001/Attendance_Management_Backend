import mongoose from 'mongoose';

const employeeSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  designation: { type: String, required: true },
  department: { type: String, required: true },
  salary: { type: Number, required: true, min: 1000 },
  paidLeaves: {
    available: { type: Number, default: 3 },
    used: { type: Number, default: 0 },
    carriedForward: { type: Number, default: 0 },
  },
  location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  documents: [{
    name: { type: String, required: true },
    path: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  }],
  phone: { type: String },
  dob: { type: Date },
}, { timestamps: true });

export default mongoose.model('Employee', employeeSchema);
