import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const downloadSchema = new mongoose.Schema({}, { strict: false });
const Download = mongoose.model('download', downloadSchema, 'downloads');

async function run() {
  try {
    await mongoose.connect(process.env.DB_URL);
    const result = await Download.updateMany(
      { status: "pending" },
      { $set: { status: "failed" } }
    );
    console.log(`Cleaned up ${result.modifiedCount} stuck pending downloads.`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
