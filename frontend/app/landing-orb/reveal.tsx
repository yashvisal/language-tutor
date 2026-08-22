"use client"

import { motion, useReducedMotion } from "motion/react"

/** A block that surfaces as it scrolls into view, once. */
export function Reveal({ children }: { children: React.ReactNode }) {
  const reducedMotion = useReducedMotion()
  if (reducedMotion) return <>{children}</>
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}
