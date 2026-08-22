"use client"

import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"

/** A block that surfaces as it scrolls into view, once. */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const reducedMotion = useReducedMotion()
  if (reducedMotion) return <div className={className}>{children}</div>
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.35 }}
      transition={{ duration: 0.55, ease: "easeOut", delay }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  )
}
