#!/usr/bin/env node
// 值班查询命令行。无第三方依赖，输出 JSON，可被其他系统管道消费。
//
// 用法：
//   node src/cli.js blocks [--as-of ISSUE]
//   node src/cli.js block <B1|B2|B3> [--as-of ISSUE]
//   node src/cli.js sites <site>
//   node src/cli.js shifts
//   node src/cli.js reconcile
//   node src/cli.js closures <window>
//   node src/cli.js plan '<plan-json>' [--now SLOT]
//   node src/cli.js vehicle '<spec-json>' [--now SLOT]
//   node src/cli.js notices
//   node src/cli.js accept <notice>
//   node src/cli.js next-day
//   node src/cli.js briefing
//   node src/cli.js basis
//   node src/cli.js forecast '<new-weather-json>' [--now SLOT]

import { ColdResponseEngine } from './engine.js'

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith('--')
        ? argv[++i] : 'true'
      flags[key] = value
    }
  }
  return flags
}

async function main() {
  const [command, arg, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  const dataUrl = new URL('../data/', import.meta.url)
  const engine = await ColdResponseEngine.fromDir(dataUrl, {
    asOf: flags['as-of'] !== undefined ? Number(flags['as-of']) : undefined,
    now: flags.now !== undefined ? Number(flags.now) : null,
  })

  let output
  switch (command) {
    case 'blocks':
      output = { asOf: engine.asOf, estimates: engine.allBlockEstimates() }
      break
    case 'block':
      output = engine.queryByBlock(arg)
      break
    case 'sites':
      output = engine.queryBySite(arg)
      break
    case 'shifts':
      output = engine.queryByShift()
      break
    case 'reconcile':
      output = engine.reconciliation()
      break
    case 'closures':
      output = engine.closureImpacts(arg)
      break
    case 'plan':
      output = engine.evaluatePlan(JSON.parse(arg))
      break
    case 'vehicle':
      output = engine.addVehicle(JSON.parse(arg))
      break
    case 'notices':
      output = engine.notices()
      break
    case 'accept':
      output = engine.accept(arg)
      break
    case 'next-day':
      output = engine.nextDay()
      break
    case 'briefing':
      output = engine.briefing()
      break
    case 'basis':
      output = engine.weatherBasis()
      break
    case 'forecast':
      output = engine.applyForecast(JSON.parse(arg))
      break
    default:
      console.error(`未知命令: ${command ?? '(空)'}`)
      process.exitCode = 2
      return
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  process.exitCode = 1
})
