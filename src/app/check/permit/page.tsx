import type { Metadata } from "next";
import { PermitCheckForm } from "./permit-check-form";

export const metadata: Metadata = {
  title: "Check an exam permit",
};

export default function PermitCheckPage() {
  return <PermitCheckForm />;
}
