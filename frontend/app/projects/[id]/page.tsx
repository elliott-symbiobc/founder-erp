"use client";

import React, { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ProjectDetailView } from "@/components/project/ProjectDetailView";

function ProjectDetailContent() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const backHref = searchParams.get("from") ?? "/projects";
  return <ProjectDetailView id={id} backHref={backHref} />;
}

export default function ProjectDetailPage() {
  return <Suspense><ProjectDetailContent /></Suspense>;
}
