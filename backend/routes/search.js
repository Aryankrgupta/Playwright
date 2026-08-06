// routes/search.js
import express from "express";
import { googleSearch } from "../services/googleSearch.js";

const router = express.Router();

const MAX_QUERY_LENGTH = 256;
const DATE_RESTRICT_RE = /^[dwmy][0-9]{1,3}$/;

function parseBoundedInt(value, { min, max, fallback }) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

// GET /api/search?q=latest+AI+news&num=10
router.get("/search", async (req, res) => {
  const { q, num, start, dateRestrict } = req.query;

  if (typeof q !== "string" || !q.trim()) {
    return res.status(400).json({ error: "Missing required query param 'q'." });
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return res
      .status(400)
      .json({ error: `Query 'q' must be at most ${MAX_QUERY_LENGTH} characters.` });
  }

  const numResults = parseBoundedInt(num, { min: 1, max: 10, fallback: 10 });
  if (numResults === null) {
    return res.status(400).json({ error: "Param 'num' must be an integer between 1 and 10." });
  }

  const startIndex = parseBoundedInt(start, { min: 1, max: 100, fallback: 1 });
  if (startIndex === null) {
    return res.status(400).json({ error: "Param 'start' must be an integer between 1 and 100." });
  }

  if (dateRestrict !== undefined && !DATE_RESTRICT_RE.test(String(dateRestrict))) {
    return res
      .status(400)
      .json({ error: "Param 'dateRestrict' must look like 'd7', 'w2', 'm1' or 'y1'." });
  }

  try {
    const results = await googleSearch(q.trim(), {
      numResults,
      startIndex,
      dateRestrict: dateRestrict || undefined,
    });
    return res.json(results);
  } catch (err) {
    console.error("[search] googleSearch failed:", err.message);
    return res.status(502).json({ error: "Upstream search request failed." });
  }
});

export default router;
