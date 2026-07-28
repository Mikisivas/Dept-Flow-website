import type { Metadata } from "next";
import { MatricCheckForm } from "./matric-check-form";

export const metadata: Metadata = {
  title: "Check a matric number",
};

export default function MatricCheckPage() {
  return <MatricCheckForm />;
}
