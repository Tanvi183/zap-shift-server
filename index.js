const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// stripe connection
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;
const crypto = require("crypto");

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

// Middleware
app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@simple-crud-server.7fhuvu7.mongodb.net/?appName=simple-crud-server`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");

    // parcel related api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      // /parcels?email=''&
      if (email) {
        query.senderEmail = email;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;

      // parcel created time
      parcel.createdAt = new Date();

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // payment related apis ( Stripe )
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],

        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },

        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      console.log(session);
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        // Session id is avaiable or not
        if (!sessionId) {
          return res.send({ success: false, message: "No session ID" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        // console.log("session retrieve", session);
        const transactionId = session.payment_intent;

        if (!session || !transactionId) {
          return res.send({ success: false, message: "Invalid session" });
        }

        // Check if payment already exists
        const existingPayment = await paymentCollection.findOne({
          transactionId,
          //This feature called object property shorthand.
          // When the key name and variable name are the same,
        });
        // console.log(existingPayment);

        if (existingPayment) {
          return res.send({
            success: true,
            message: "Payment already processed",
            transactionId,
            trackingId: existingPayment.trackingId,
          });
        }

        // Ensure metadata exists
        if (!session.metadata || !session.metadata.parcelId) {
          return res.send({
            success: false,
            message: "Missing metadata in Stripe session",
          });
        }

        const trackingId = generateTrackingId();

        // Only handle paid sessions
        if (session.payment_status !== "paid") {
          return res.send({
            success: false,
            message: "Payment is not marked as paid",
          });
        }

        const parcelId = session.metadata.parcelId;

        // Update parcel as paid
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentStatus: "paid",
              trackingId,
            },
          }
        );

        // Create payment record
        const paymentData = {
          amount: Number(session.amount_total) / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId,
          parcelName: session.metadata.parcelName,
          transactionId,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId,
        };

        const paymentInserted = await paymentCollection.insertOne(paymentData);

        return res.send({
          success: true,
          message: "Payment processed successfully",
          trackingId,
          transactionId,
          modifyParcel: parcelUpdate,
          paymentInfo: paymentInserted,
        });
      } catch (error) {
        console.error("Payment success error:", error);
        return res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
