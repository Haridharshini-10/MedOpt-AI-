const express = require("express");
const mysql = require("mysql2/promise");
const bodyParser = require("body-parser");
const cors = require("cors");
const twilio = require("twilio");
const cron = require("node-cron");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = 5002;

// ✅ Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Twilio Setup
const client = twilio("//replace", "//replace");

// ✅ MySQL Database Connection
const db = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "", // Update if necessary
    database: "patient_reminder",
});

// ✅ Utility Function: Generate Secure Token
function generateToken() {
    return crypto.randomBytes(16).toString("hex"); // Generates a 32-character token
}

// ✅ Scheduled Task (Runs daily at 9:47 AM IST)
cron.schedule("46 11 * * *", async () => {
    console.log("📅 Running scheduled reminder task...");
    try {
        const response = await axios.post("http://localhost:5002/send-reminder");
        console.log(response.data.message);
    } catch (error) {
        console.error("❌ Failed to send scheduled reminders:", error);
    }
});

// ✅ Receive SMS Responses (Handles patient confirmations)
app.post("/receive-sms", async (req, res) => {
    const { From, Body } = req.body;
    console.log(`📩 Received SMS from ${From}: ${Body}`);

    if (Body.trim().toLowerCase() === "yes") {
        try {
            await db.query("UPDATE patients SET needs_reminder = FALSE WHERE phone_number = ?", [From]);
            console.log(`✅ Updated reminder status for ${From}`);
            res.json({ message: "Reminder status updated!" });
        } catch (error) {
            console.error("❌ Error updating patient status:", error);
            res.status(500).json({ message: "Failed to update patient status." });
        }
    } else {
        res.json({ message: "No action needed." });
    }
});

// ✅ Send Reminder Messages
app.post("/send-reminder", async (req, res) => {
    try {
        const [patients] = await db.query("SELECT id, phone_number FROM patients WHERE needs_reminder = TRUE");

        if (patients.length === 0) {
            console.log("✅ No patients need reminders right now.");
            return res.json({ message: "No patients need reminders right now." });
        }

        for (const patient of patients) {
            let formattedPhoneNumber = patient.phone_number.replace(/\s+/g, "");
            if (!formattedPhoneNumber.startsWith("+91")) {
                formattedPhoneNumber = `+91${formattedPhoneNumber}`;
            }

            // ✅ Check if a reminder was already sent today
            const [existingReminder] = await db.query(
                "SELECT * FROM reminders WHERE patient_id = ? AND DATE(sent_at) = CURDATE()",
                [patient.id]
            );

            if (existingReminder.length > 0) {
                console.log(`⚠ Reminder already sent to ${formattedPhoneNumber} today. Skipping.`);
                continue;
            }

            // ✅ Get best reminder suggestion from Q-learning
            const response = await axios.post("http://127.0.0.1:5002/get-reminder", { state: "Missed" });

            // ✅ Generate a unique confirmation token
            const confirmationToken = crypto.randomBytes(16).toString("hex");

            // ✅ Save the reminder and token in the database
            await db.query(
                "INSERT INTO reminders (patient_id, state, reminder_action, confirmation_token, sent_at) VALUES (?, ?, ?, ?, NOW())",
                [patient.id, "Missed", response.data.reminder, confirmationToken]
            );

            // ✅ Send SMS with the correct link
            try {
                const message = await client.messages.create({
                    body: `Reminder It is time to take  Dolo 650 tablet : ${response.data.reminder}. Click here to confirm: https://yourwebsite.com/reminders?token=${confirmationToken}`,
                    from: "+14176203834",
                    to: formattedPhoneNumber,
                });

                console.log(`✅ SMS sent successfully to ${formattedPhoneNumber}, SID: ${message.sid}`);
            } catch (twilioError) {
                console.error(`❌ Twilio Error sending SMS to ${formattedPhoneNumber}:`, twilioError);
            }
        }

        res.json({ message: "Reminders sent to all patients who need them!" });

    } catch (error) {
        console.error("❌ Error sending reminders:", error);
        res.status(500).json({ message: "Failed to send reminders." });
    }
});


// ✅ Confirm Reminder (Secure Token System)
app.get("/confirm-reminder", async (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).send("<h3>Invalid request. Token is required.</h3>");
    }

    try {
        // Find the reminder using the token
        const [reminder] = await db.query("SELECT patient_id FROM reminders WHERE confirmation_token = ?", [token]);

        if (reminder.length === 0) {
            return res.status(404).send("<h3>Invalid or expired token.</h3>");
        }

        const patientId = reminder[0].patient_id;

        // ✅ Update the database to mark the reminder as confirmed
        await db.query("UPDATE patients SET needs_reminder = FALSE WHERE id = ?", [patientId]);

        // ✅ Send this update to Q-learning API
        await axios.post("http://127.0.0.1:5002/update-qlearning", {
            state: "On Time",
            action: "Remind On Time"
        });

        res.send(`
            <html>
                <head><title>Reminder Confirmed</title></head>
                <body>
                    <h2>✅ Your reminder confirmation has been recorded!</h2>
                    <p>Thank you for confirming.</p>
                </body>
            </html>
        `);
    } catch (error) {
        console.error("❌ Error updating reminder:", error);
        res.status(500).send("<h3>Failed to update reminder.</h3>");
    }
});


// ✅ Send a Custom SMS
app.post("/send-sms", async (req, res) => {
    const { phone_number, message } = req.body;

    // ✅ Check if required fields are provided
    if (!phone_number || !message) {
        return res.status(400).json({ message: "Phone number and message are required." });
    }

    // ✅ Format phone number correctly
    let formattedPhoneNumber = phone_number.replace(/\s+/g, ""); // Remove spaces
    if (!formattedPhoneNumber.startsWith("+91")) {
        formattedPhoneNumber = `+91${formattedPhoneNumber}`;
    }

    // ✅ Generate a secure token instead of using the phone number
    const token = crypto.randomBytes(16).toString("hex");

    try {
        // ✅ Prevent sending duplicate SMS (check if sent in last 5 minutes)
        const [recentMessages] = await db.query(
            "SELECT COUNT(*) AS count FROM sms_logs WHERE phone_number = ? AND message = ? AND TIMESTAMPDIFF(MINUTE, sent_at, NOW()) < 5",
            [formattedPhoneNumber, message]
        );

        if (recentMessages[0].count > 0) {
            console.log(`⚠ SMS already sent to ${formattedPhoneNumber} recently. Skipping.`);
            return res.status(429).json({ message: "SMS already sent recently." });
        }

        // ✅ Save token in database (instead of exposing phone number)
        await db.query(
            "INSERT INTO sms_logs (phone_number, message, token, sent_at) VALUES (?, ?, ?, NOW())",
            [formattedPhoneNumber, message, token]
        );

        // ✅ Create the secure link with token
        const secureLink = `https://yourwebsite.com/reminders?token=${token}`;

        // ✅ Send SMS with only the secure link (no phone number)
        const twilioResponse = await client.messages.create({
            body: `New message: ${message}. Click here to view details: ${secureLink}`,
            from: "+14176203834",
            to: formattedPhoneNumber,
        });

        console.log(`✅ SMS sent successfully, Token: ${token}`);

        // ✅ Only return success message (No phone number or SID)
        res.json({ message: "SMS sent successfully!", link: secureLink });

    } catch (error) {
        console.error("❌ Error sending SMS:", error);
        res.status(500).json({ message: "Failed to send SMS." });
    }
});


app.post("/add-patient", async (req, res) => {
    const { patient_name, age, phone_number, issues, hospital_name, feedback, needs_reminder } = req.body;

    if (!patient_name || !age || !phone_number || !issues || !hospital_name) {
        return res.status(400).json({ message: "All fields are required." });
    }

    try {
        const sql = `INSERT INTO patients (patient_name, age, phone_number, issues, hospital_name, feedback, needs_reminder) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await db.query(sql, [patient_name, age, phone_number, issues, hospital_name, feedback, needs_reminder]);

        res.status(201).json({ message: "Patient added successfully!" });

    } catch (err) {
        console.error("❌ Database Error:", err);
        res.status(500).json({ message: "Error adding patient." });
    }
});




// ✅ Get All Patients
app.get("/patients", async (req, res) => {
    try {
        const [patients] = await db.query("SELECT * FROM patients");
        res.json(patients);
    } catch (err) {
        console.error("Error fetching patients:", err);
        res.status(500).json({ message: "Error fetching patients." });
    }
});

// ✅ Get Single Patient by ID (Fixing patient_id to id)
app.get("/patients/:id", async (req, res) => {
    const { id } = req.params;

    try {
        console.log("Fetching patient with ID:", id); // Debugging log
        const [patient] = await db.query("SELECT * FROM patients WHERE id = ?", [id]);

        if (patient.length === 0) {
            return res.status(404).json({ message: "Patient not found." });
        }

        res.json(patient[0]); // Send patient data

    } catch (err) {
        console.error("Error fetching patient:", err);
        res.status(500).json({ message: "Error fetching patient." });
    }
});

// ✅ Delete a Patient by ID (Fixing patient_id to id)
app.delete("/patients/:id", async (req, res) => {
    const { id } = req.params;

    if (!id || isNaN(id)) {
        console.error("Invalid patient ID:", id);
        return res.status(400).json({ message: "Invalid patient ID." });
    }

    try {
        console.log("Deleting patient with ID:", id); // Debugging log

        const [result] = await db.query("DELETE FROM patients WHERE id = ?", [id]);

        if (result.affectedRows === 0) {
            console.error("Patient not found.");
            return res.status(404).json({ message: "Patient not found." });
        }

        res.json({ message: "Patient deleted successfully!" });

    } catch (err) {
        console.error("Error deleting patient:", err);
        res.status(500).json({ message: "Error deleting patient." });
    }
});


app.put("/patients/:id", async (req, res) => {
    const { id } = req.params;
    const { patient_name, age, phone_number, issues, hospital_name, feedback } = req.body;

    try {
        console.log("Updating patient with ID: ${id}"); // Debugging log

        const sql = `UPDATE patients SET 
                     patient_name = ?, age = ?, phone_number = ?, issues = ?, hospital_name = ?, feedback = ? 
                     WHERE id = ?`; // <-- FIXED: Changed 'patient_id' to 'id'

        const [result] = await db.query(sql, [patient_name, age, phone_number, issues, hospital_name, feedback, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Patient not found." });
        }

        res.json({ message: "Patient updated successfully!" });

    } catch (err) {
        console.error("Error updating patient:", err);
        res.status(500).json({ message: "Error updating patient." });
    }
});




// ✅ Get All Hospitals (for dropdown selection)
app.get("/hospitals", async (req, res) => {
    try {
        const [hospitals] = await db.query("SELECT DISTINCT hospital_name FROM patients");
        res.json(hospitals);
    } catch (err) {
        console.error("Error fetching hospitals:", err);
        res.status(500).json({ message: "Error fetching hospitals." });
    }
});

// ✅ Fetch reminder history for a patient
app.get("/reminders/:patient_id", async (req, res) => {
    const { patient_id } = req.params;

    try {
        const [reminders] = await db.query(`
            SELECT r.id, r.state, r.reminder_action, r.sent_at
            FROM reminders r
            WHERE r.patient_id = ?
            ORDER BY r.sent_at DESC
        `, [patient_id]);

        res.json(reminders);
    } catch (err) {
        console.error("Error fetching reminders:", err);
        res.status(500).json({ message: "Error fetching reminders." });
    }
});

// ✅ Store a new reminder
app.post("/add-reminder", async (req, res) => {
    const { patient_id, state, reminder_action } = req.body;

    if (!patient_id || !state || !reminder_action) {
        return res.status(400).json({ message: "Required fields are missing." });
    }

    try {
        const sql = `INSERT INTO reminders (patient_id, state, reminder_action) VALUES (?, ?, ?)`;
        await db.query(sql, [patient_id, state, reminder_action]);

        res.status(201).json({ message: "Reminder added successfully!" });
    } catch (err) {
        console.error("Error adding reminder:", err);
        res.status(500).json({ message: "Error adding reminder." });
    }
});

app.put("/update-reminder-status", async (req, res) => {
    const { patient_id } = req.body;

    try {
        await db.query("UPDATE patients SET needs_reminder = FALSE WHERE id = ?", [patient_id]);
        res.json({ message: "Reminder status updated successfully!" });
    } catch (error) {
        console.error("Error updating reminder status:", error);
        res.status(500).json({ message: "Error updating reminder status." });
    }
});

// ✅ Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});