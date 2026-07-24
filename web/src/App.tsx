import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { FiltersProvider } from './lib/filters'
import { Layout } from './components/Layout'
import ShipmentsPage from './modules/shipments'
import WipPage from './modules/wip'
import OrdersPage from './modules/orders'
import FloorPage from './modules/floor'
import CsPage from './modules/cs'
import NpsPage from './modules/nps'
import BowlerPage from './modules/bowler'
import RmaPage from './modules/rma'
import LeadTimePage from './modules/leadtime'
import CustomersPage from './modules/customers'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      retry: 0, // Redash errors carry actionable hints (VPN, key) — fail fast, don't hammer.
      refetchOnWindowFocus: false,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <FiltersProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Navigate to="/shipments" replace />} />
              <Route path="/shipments" element={<ShipmentsPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/wip" element={<WipPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/floor" element={<FloorPage />} />
              <Route path="/cs" element={<CsPage />} />
              <Route path="/nps" element={<NpsPage />} />
              <Route path="/bowler" element={<BowlerPage />} />
              <Route path="/rma" element={<RmaPage />} />
              <Route path="/leadtime" element={<LeadTimePage />} />
              <Route path="*" element={<Navigate to="/shipments" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </FiltersProvider>
    </QueryClientProvider>
  )
}
