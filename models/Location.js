// src/models/Location.js
import mongoose from 'mongoose';

const locationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  address: {
    type: String,
    required: true,
  },
  city: {
    type: String,
    required: true,
  },
  state: {
    type: String,
    required: true,
  },
  isDeleted: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// Drop existing text indexes to avoid conflicts
locationSchema.indexes().forEach((index) => {
  if (index.key && index.key._fts === 'text') {
    locationSchema.dropIndex(index.name);
  }
});

// Create text index with weights
locationSchema.index(
  { name: 'text', address: 'text', city: 'text', state: 'text' },
  { weights: { name: 10, address: 5, city: 3, state: 3 } }
);

export default mongoose.model('Location', locationSchema);