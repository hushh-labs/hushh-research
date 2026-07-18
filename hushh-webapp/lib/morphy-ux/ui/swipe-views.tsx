"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel";

type RouteTab = {
  id: string;
  href: string;
};

export function RouteSwipeViews({
  tabs,
  activeId,
  children,
}: {
  tabs: RouteTab[];
  activeId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [api, setApi] = React.useState<CarouselApi>();

  const activeIndex = React.useMemo(() => {
    return Math.max(
      0,
      tabs.findIndex((t) => t.id === activeId)
    );
  }, [activeId, tabs]);

  // Sync scroll momentum to Next.js route
  React.useEffect(() => {
    if (!api) return;

    const onSelect = () => {
      const selectedIndex = api.selectedScrollSnap();
      if (selectedIndex !== activeIndex) {
        const targetTab = tabs[selectedIndex];
        if (targetTab && targetTab.href !== pathname) {
          router.push(targetTab.href, { scroll: false });
        }
      }
    };

    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api, activeIndex, tabs, pathname, router]);

  // Sync incoming route back to the carousel position
  React.useEffect(() => {
    if (api && api.selectedScrollSnap() !== activeIndex) {
      api.scrollTo(activeIndex);
    }
  }, [api, activeIndex]);

  return (
    <Carousel
      setApi={setApi}
      opts={{
        align: "start",
        loop: false,
        dragFree: false,
        skipSnaps: false,
      }}
      className="w-full flex-1"
    >
      <CarouselContent className="h-full m-0">
        {tabs.map((tab, idx) => (
          <CarouselItem key={tab.id} className="h-full pl-0">
            {idx === activeIndex ? children : <div className="h-full w-full" />}
          </CarouselItem>
        ))}
      </CarouselContent>
    </Carousel>
  );
}
