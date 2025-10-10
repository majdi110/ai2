import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import Suppliers from './pages/Suppliers';

export default function App() {
  return (
    <BrowserRouter>
      <nav className="bg-gray-100 p-4 flex gap-4">
        <Link to="/">Dashboard</Link>
        <Link to="/products">Products</Link>
        <Link to="/suppliers">Suppliers</Link>
      </nav>
      <div className="p-4">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Products />} />
          <Route path="/suppliers" element={<Suppliers />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

 
