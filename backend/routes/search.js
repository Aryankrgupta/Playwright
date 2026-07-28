// routes/search.js
import express from "express";
import { googleSearch } from "../services/googleSearch.js";

const router = express.Router();

// GET /api/search?q=latest+AI+news&num=10
router.get("/search", async (req, res) => {
  const { q, num, start, dateRestrict } = req.query;

  if (!q) {
    return res.status(400).json({ error: "Missing required query param 'q'." });
  }

  try {
    const results = await googleSearch(q, {
      numResults: num ? parseInt(num, 10) : 10,
      startIndex: start ? parseInt(start, 10) : 1,
      dateRestrict: dateRestrict || undefined,
    });
    return res.json(results);
  } catch (err) {
    console.error("[search] googleSearch failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

export default router;