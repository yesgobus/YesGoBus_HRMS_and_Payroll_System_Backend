const mysql = require("mysql2");

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "MySQL@12345",
  database: "hrms_db"
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("MySQL connection failed:", err.message);
  } else {
    console.log("MySQL connected successfully");
    connection.release();
  }
});

module.exports = db;