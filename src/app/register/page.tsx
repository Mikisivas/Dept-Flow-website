import type { Metadata } from "next";
import { Registration } from "./registration";

export const metadata: Metadata = {
  title: "Create account",
};

export default function RegisterPage() {
  return <Registration />;
}
