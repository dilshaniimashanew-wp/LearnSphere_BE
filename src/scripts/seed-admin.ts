import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import { hashPassword } from "../modules/auth/auth.service.js";
import { User } from "../modules/users/user.model.js";

// Admins are never created through public registration. This trusted script is the only way.
async function main() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env");
  await connectDb();
  const email = env.ADMIN_EMAIL.toLowerCase();
  if (await User.exists({ email })) {
    console.log(`Admin ${email} already exists`);
  } else {
    await User.create({ name: "Administrator", email, role: "admin", passwordHash: await hashPassword(env.ADMIN_PASSWORD) });
    console.log(`Created admin ${email}`);
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
