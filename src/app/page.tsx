import LandingPage from "@/components/landing/landing-page";
import { getCurrentUser } from "@/lib/auth";

export default async function Home() {
  const user = await getCurrentUser();
  return <LandingPage signedIn={Boolean(user)} />;
}
