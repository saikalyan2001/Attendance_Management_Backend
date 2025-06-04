import mongoose from 'mongoose';

const holidaySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 100,
  },
  date: {
    type: Date,
    required: true,
    unique: true,
  },
  location: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    default: null, // null means holiday applies to all locations
  },
}, { timestamps: true });

export default mongoose.model('Holiday', holidaySchema);
