"use client"

/**
 * The days the learner spoke, as a contributions-style grid: 26 columns of
 * seven cells, one cell per day, darker the longer they talked.
 *
 * Hand-rolled rather than `react-activity-calendar`. That package does accept
 * React 19, but it is themed by handing it literal colour strings — there is no
 * per-cell className seam — and this surface is theme-token-only in two modes.
 * It also drags in `@floating-ui/react` and `date-fns` for what is, underneath,
 * a fixed 182-cell CSS grid and a `Map` keyed by day.
 *
 * Two decisions worth knowing:
 *
 * - **Days are bucketed here, not in Convex.** `sessions.activity` returns raw
 *   timestamps; midnight is the learner's, and only the browser knows where
 *   that is.
 * - **One tooltip, not 182.** The grid geometry is fixed (11px cells on a 14px
 *   pitch), so the hovered cell's position is arithmetic — a single absolutely
 *   positioned label beats mounting a Base UI tooltip root per cell.
 *
 * The grid renders at full size before the data arrives and before the client
 * knows what day it is, so the page never reflows underneath it.
 */

import { useMemo, useState, useSyncExternalStore } from "react"
import { useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"
import { formatClock } from "@/lib/billing"
import { cn } from "@/lib/utils"

const WEEKS = 26
const ROWS = 7
/** Cell edge and gap, in px. The tooltip's position is derived from these. */
const CELL = 11
const GAP = 3
const PITCH = CELL + GAP

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]
/** Which rows get a weekday hint. Sunday is row 0. */
const WEEKDAY_HINTS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" }

/**
 * Seconds → intensity. The breakpoints are minutes of talking, not quartiles
 * of this learner's own history: a quiet week should look quiet, and a scale
 * that renormalises would hide that.
 */
const LEVELS = [60, 180, 360] as const

function levelFor(seconds: number): 0 | 1 | 2 | 3 | 4 {
  if (seconds <= 0) return 0
  if (seconds < LEVELS[0]) return 1
  if (seconds < LEVELS[1]) return 2
  if (seconds < LEVELS[2]) return 3
  return 4
}

const LEVEL_CLASS: Record<number, string> = {
  0: "bg-foreground/[0.06] dark:bg-white/[0.08]",
  1: "bg-primary/25",
  2: "bg-primary/45",
  3: "bg-primary/70",
  4: "bg-primary",
}

/** A store that never changes: the only thing it reports is which side of
 * hydration we are on. */
const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

/** `YYYY-MM-DD` in local time. `toISOString` would be UTC's answer. */
function dayKey(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, "0")
  const d = `${date.getDate()}`.padStart(2, "0")
  return `${date.getFullYear()}-${m}-${d}`
}

type Cell = { key: string; date: Date; seconds: number; future: boolean }

export function ActivityCalendar() {
  const sessions = useQuery(api.sessions.activity)

  // The grid's first day depends on today, which the server and the browser can
  // disagree about across a timezone. Nothing date-derived renders until the
  // client has taken over — `false` on the server, `true` after hydration.
  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer)

  const secondsByDay = useMemo(() => {
    const map = new Map<string, number>()
    for (const session of sessions ?? []) {
      if (session.seconds <= 0) continue
      const key = dayKey(new Date(session.startedAt))
      map.set(key, (map.get(key) ?? 0) + session.seconds)
    }
    return map
  }, [sessions])

  const columns = useMemo(() => {
    if (!mounted) return null

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // The last column is the current week, so the grid starts on the Sunday
    // (WEEKS - 1) weeks before this one.
    const start = new Date(today)
    start.setDate(start.getDate() - today.getDay() - (WEEKS - 1) * 7)

    const out: Cell[][] = []
    for (let week = 0; week < WEEKS; week++) {
      const column: Cell[] = []
      for (let row = 0; row < ROWS; row++) {
        const date = new Date(start)
        date.setDate(start.getDate() + week * 7 + row)
        const key = dayKey(date)
        column.push({
          key,
          date,
          seconds: secondsByDay.get(key) ?? 0,
          future: date.getTime() > today.getTime(),
        })
      }
      out.push(column)
    }
    return out
  }, [mounted, secondsByDay])

  /** A column gets a month label when its first day opens a new month. */
  const monthLabels = useMemo(() => {
    if (columns === null) return []
    const labels: { week: number; label: string }[] = []
    let previous = -1
    columns.forEach((column, week) => {
      const month = column[0].date.getMonth()
      if (month !== previous) {
        // Skip a label that would sit in the first column and be clipped by the
        // one before it running off the left edge.
        if (previous !== -1 || column[0].date.getDate() <= 7) {
          labels.push({ week, label: MONTHS[month] })
        }
        previous = month
      }
    })
    return labels
  }, [columns])

  const [hovered, setHovered] = useState<{
    week: number
    row: number
    cell: Cell
  } | null>(null)

  const spokeAnyDay = secondsByDay.size > 0
  const gridWidth = WEEKS * PITCH - GAP
  const gridHeight = ROWS * PITCH - GAP

  return (
    <section aria-labelledby="activity-heading" className="w-full">
      <h2
        id="activity-heading"
        className="text-xs font-medium tracking-wide text-muted-foreground"
      >
        Days you spoke
      </h2>

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {/* Weekday hints, aligned to the grid rows — the month strip above the
            grid is matched by an equal spacer here. */}
        <div
          className="flex shrink-0 flex-col text-[10px] leading-none text-muted-foreground"
          style={{ paddingTop: 16, gap: GAP }}
          aria-hidden
        >
          {Array.from({ length: ROWS }, (_, row) => (
            <span
              key={row}
              className="flex items-center"
              style={{ height: CELL }}
            >
              {WEEKDAY_HINTS[row] ?? ""}
            </span>
          ))}
        </div>

        <div className="relative shrink-0" onMouseLeave={() => setHovered(null)}>
          {/* Month strip. Absolute inside a reserved 16px band so the labels
              can't push the grid around as their widths change. */}
          <div className="relative h-4" style={{ width: gridWidth }} aria-hidden>
            {monthLabels.map((month) => (
              <span
                key={`${month.week}-${month.label}`}
                className="absolute top-0 text-[10px] leading-none text-muted-foreground"
                style={{ left: month.week * PITCH }}
              >
                {month.label}
              </span>
            ))}
          </div>

          <div
            className="grid grid-flow-col"
            style={{
              width: gridWidth,
              height: gridHeight,
              gap: GAP,
              gridTemplateRows: `repeat(${ROWS}, ${CELL}px)`,
              gridTemplateColumns: `repeat(${WEEKS}, ${CELL}px)`,
            }}
            role="img"
            aria-label={
              spokeAnyDay
                ? `Conversation activity over the last ${WEEKS} weeks`
                : "No conversations yet"
            }
          >
            {(columns ?? placeholderColumns()).map((column, week) =>
              column.map((cell, row) =>
                cell.future ? (
                  <div key={cell.key} />
                ) : (
                  <div
                    key={cell.key}
                    onMouseEnter={() => setHovered({ week, row, cell })}
                    className={cn(
                      "rounded-[2px] transition-colors",
                      LEVEL_CLASS[levelFor(cell.seconds)]
                    )}
                  />
                )
              )
            )}
          </div>

          {hovered !== null && (
            <div
              className={cn(
                "pointer-events-none absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm",
                // The top two rows would put the label over the month strip,
                // so those flip under the cell instead.
                hovered.row > 1 ? "-translate-y-full" : ""
              )}
              style={{
                // +16 clears the month strip the grid sits under; the ±4 lifts
                // the label off the cell it describes.
                left: hovered.week * PITCH + CELL / 2,
                top:
                  hovered.row > 1
                    ? 16 + hovered.row * PITCH - 4
                    : 16 + hovered.row * PITCH + CELL + 4,
              }}
            >
              {describe(hovered.cell)}
            </div>
          )}
        </div>

        <div
          className="ml-auto flex shrink-0 items-end gap-1 pb-px text-[10px] text-muted-foreground"
          aria-hidden
        >
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className={cn("rounded-[2px]", LEVEL_CLASS[level])}
              style={{ width: CELL, height: CELL }}
            />
          ))}
          <span>More</span>
        </div>
      </div>

      {/* Only once the data has actually arrived — an empty grid while the
          query is in flight isn't evidence of anything. */}
      {sessions !== undefined && !spokeAnyDay && (
        <p className="mt-2 text-xs text-muted-foreground">
          Your first conversation lights up today.
        </p>
      )}
    </section>
  )
}

/** "Tue 12 Aug · 4:32 talked" — the weekday and month names are ours so the
 * string doesn't change shape with the browser's locale. */
function describe(cell: Cell): string {
  const when = `${WEEKDAYS[cell.date.getDay()]} ${cell.date.getDate()} ${MONTHS[cell.date.getMonth()]}`
  if (cell.seconds <= 0) return `${when} · nothing spoken`
  return `${when} · ${formatClock(cell.seconds)} talked`
}

/** The pre-mount grid: the right number of cells at the right size, with no
 * dates in them, so the reserved space is exact. */
function placeholderColumns(): Cell[][] {
  const epoch = new Date(0)
  return Array.from({ length: WEEKS }, (_, week) =>
    Array.from({ length: ROWS }, (_, row) => ({
      key: `placeholder-${week}-${row}`,
      date: epoch,
      seconds: 0,
      future: false,
    }))
  )
}
