require("dotenv").config();

const mysql = require("mysql2");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,

  // Return MySQL DATE values as YYYY-MM-DD strings
  // instead of JavaScript Date objects/timezone-converted values
  dateStrings: true,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test MySQL connection
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ MySQL Connection Failed:", err.message);
    return;
  }

  console.log("✅ MySQL Connected Successfully!");
  console.log(`📌 Database: ${process.env.DB_NAME}`);

  connection.release();
});

module.exports = db;