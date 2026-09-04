import ShareLinkClient from "@/components/files/share-link-client";

export default async function ShareLinkPage({
  params,
}: PageProps<"/share/[token]">) {
  const { token } = await params;
  return <ShareLinkClient token={token} />;
}
