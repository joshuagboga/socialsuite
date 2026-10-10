// Set a new password for a user, for when someone is locked out.
//   npm run reset-password -- someone@example.com "their new password"
// Run it on the server, with the same .env / DATA_DIR the app uses. It also signs them out everywhere.

import "dotenv/config";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run reset-password -- <email> "<new password>"');
  process.exit(1);
}
try {
  const { resetPassword } = await import("../src/auth.js");
  const user = await resetPassword(email, password);
  console.log(`Password updated for ${user.email}. They have been signed out of all devices.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
