import type { QueryRegistry } from '../registry.js'
import { dimQueries } from './dims.js'
import { shipmentQueries } from './shipments.js'
import { wipQueries } from './wip.js'
import { orderQueries } from './orders.js'
import { floorQueries } from './floor.js'
import { bowlerQueries } from './bowler.js'
import { leadtimeQueries } from './leadtime.js'

export const registry: QueryRegistry = {
  ...dimQueries,
  ...shipmentQueries,
  ...wipQueries,
  ...orderQueries,
  ...floorQueries,
  ...bowlerQueries,
  ...leadtimeQueries,
}
