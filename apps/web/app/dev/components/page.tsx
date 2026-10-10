import type { Metadata } from "next";
import { Gallery } from "./Gallery";

export const metadata: Metadata = { title: "Component gallery" };

/** Dev-only gallery of every design-system component in every state (used by e2e tests). */
export default function ComponentsGalleryPage() {
  return <Gallery />;
}
