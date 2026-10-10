// Uploads (UC-24). POST /uploads is multipart; the response carries stored metadata.
import { z } from "zod";
import { UploadSchema } from "../domain/upload.js";

export const UploadRejectedSchema = z.object({
  filename: z.string().min(1),
  /** Message naming the file (checkUploadFile). */
  reason: z.string().min(1),
});

export const UploadsResponseSchema = z.object({
  uploads: z.array(UploadSchema),
  rejected: z.array(UploadRejectedSchema),
});
export type UploadsResponse = z.infer<typeof UploadsResponseSchema>;
