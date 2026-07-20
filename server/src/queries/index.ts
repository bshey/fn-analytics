import type { QueryRegistry } from '../registry.js'
import { dimQueries } from './dims.js'
import { shipmentQueries } from './shipments.js'
import { wipQueries } from './wip.js'
import { orderQueries } from './orders.js'
import { floorQueries } from './floor.js'
import { predictorQueries } from './predictor.js'
import { bowlerQueries } from './bowler.js'

export const registry: QueryRegistry = {
  ...dimQueries,
  ...shipmentQueries,
  ...wipQueries,
  ...orderQueries,
  ...floorQueries,
  ...predictorQueries,
  ...bowlerQueries,
}
