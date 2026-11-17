require("dotenv").config();

const db = require("../db");

async function autoCheckout() {
  try {
    const dryRun = process.argv.includes("--dry-run");

    const query = `
      UPDATE attendance
      SET check_out = '18:30:00'
      WHERE attendance_date =
        DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
        AND check_in IS NOT NULL
        AND check_in <= '18:30:00'
        AND check_out IS NULL
    `;

    if (dryRun) {
      const [rows] = await db.promise().execute(`
        SELECT COUNT(*) AS pendingCount
        FROM attendance
        WHERE attendance_date =
          DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
          AND check_in IS NOT NULL
          AND check_in <= '18:30:00'
          AND check_out IS NULL
      `);

      console.log("Employees pending automatic checkout:", rows[0].pendingCount);
      return;
    }

    const [result] = await db.promise().execute(query);

    console.log(
      `Automatic checkout completed. Updated employees: ${result.affectedRows}`
    );
  } catch (error) {
    console.error("Automatic checkout failed:", error);
    process.exitCode = 1;
  } finally {
    await db.promise().end();
  }
}

autoCheckout();
