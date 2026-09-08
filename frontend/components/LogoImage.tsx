"use client";

import { useEffect, useState } from "react";

interface LogoImageProps {
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
}

let cacheBust = 0;
export function bumpLogoCacheBust() {
  cacheBust = Date.now();
}

export default function LogoImage({ className, style, alt = "Founder ERP" }: LogoImageProps) {
  const [key, setKey] = useState(0);

  useEffect(() => {
    setKey(cacheBust || Date.now());
  }, []);

  return (
    <img
      key={key}
      src={key ? `/api/logo?v=${key}` : "/logo.svg"}
      alt={alt}
      className={className}
      style={style}
      onError={(e) => {
        const img = e.currentTarget;
        if (!img.src.includes("logo.svg")) {
          img.src = "/logo.svg";
        }
      }}
    />
  );
}
