// Background worker — processes metadata-fetch jobs and runs the write-behind
// click flush on a repeatable 10-minute schedule.

import { Worker, Queue } from "bullmq";
import type { Job } from "bullmq";

import {
  METADATA_QUEUE,
  CLICK_FLUSH_QUEUE,
  redisConnection,
} from "./queue.js";
import type { MetadataJobData } from "./queue.js";
import { fetchBookmarkMetadata, flushBookmarkClicks } from "./tasks.js";
import { makeLogger } from "./logging_config.js";

const logger = makeLogger("app.worker");
const connection = redisConnection();

const metadataWorker = new Worker<MetadataJobData>(
  METADATA_QUEUE,
  async (job: Job<MetadataJobData>) =>
    fetchBookmarkMetadata(job.data.bookmarkId, job.data.url),
  { connection }
);

const flushWorker = new Worker(CLICK_FLUSH_QUEUE, async () => flushBookmarkClicks(), {
  connection,
});

// Schedule the flush every 10 minutes. BullMQ 6 uses a job scheduler instead of
// the removed `repeat` option on queue.add(). Upsert is idempotent by id.
const flushQueue = new Queue(CLICK_FLUSH_QUEUE, { connection });
void flushQueue.upsertJobScheduler(
  "flush-clicks",
  { pattern: "*/10 * * * *" },
  { name: "flush", data: {}, opts: { removeOnComplete: true } }
);

for (const worker of [metadataWorker, flushWorker]) {
  worker.on("failed", (job, err) => logger.error(`Job ${job?.id} failed: ${err.message}`));
}

logger.info("Bookmark manager worker started");
