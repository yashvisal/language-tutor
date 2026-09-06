"use client"

import { createContext, useContext, type ReactNode } from "react"
import { targetLanguage } from "@/lib/session/plan"

const SessionLanguage = createContext("es")

/** Scoped to a conversation, including portals and historical records. */
export function SessionLanguageProvider({
  language,
  children,
}: {
  language?: string
  children: ReactNode
}) {
  return (
    <SessionLanguage value={targetLanguage(language)}>
      {children}
    </SessionLanguage>
  )
}

export function useSessionLanguage() {
  return useContext(SessionLanguage)
}
