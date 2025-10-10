import { Link } from 'react-router-dom';

export default function Navbar() {
  const links = [
    'Home', 'About', 'Services', 'Dashboard', 'Projects', 'Blog', 'Pricing', 'FAQ', 'Contact', 'Settings'
  ];
  return (
    <nav className="bg-white shadow p-4 flex flex-wrap justify-center gap-4">
      {links.map(link => (
        <Link
          key={link}
          to={link === 'Home' ? '/' : `/${link.toLowerCase()}`}
          className="text-gray-700 hover:text-blue-600 font-medium"
        >
          {link}
        </Link>
      ))}
    </nav>
  );
}
