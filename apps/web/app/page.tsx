import { redirect } from "next/navigation";

/** Chat is the home screen (spec §11). */
export default function Home() {
  redirect("/chat");
}
