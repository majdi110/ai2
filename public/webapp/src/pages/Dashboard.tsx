import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const data = [
  { name: 'Mon', uv: 400, pv: 240 },
  { name: 'Tue', uv: 300, pv: 456 },
  { name: 'Wed', uv: 200, pv: 139 },
  { name: 'Thu', uv: 278, pv: 390 },
  { name: 'Fri', uv: 189, pv: 480 },
  { name: 'Sat', uv: 239, pv: 380 },
  { name: 'Sun', uv: 349, pv: 430 },
];

export default function Dashboard() {
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6 text-center">Dashboard Overview</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white shadow rounded-2xl p-4 text-center">
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-2xl font-bold text-blue-600 mt-2">1,245</p>
        </div>
        <div className="bg-white shadow rounded-2xl p-4 text-center">
          <h2 className="text-lg font-semibold">Sales</h2>
          <p className="text-2xl font-bold text-green-600 mt-2">$8,920</p>
        </div>
        <div className="bg-white shadow rounded-2xl p-4 text-center">
          <h2 className="text-lg font-semibold">Growth</h2>
          <p className="text-2xl font-bold text-purple-600 mt-2">+12.4%</p>
        </div>
      </div>

      <div className="bg-white shadow rounded-2xl p-4">
        <h2 className="text-xl font-semibold mb-4">Weekly Performance</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <Line type="monotone" dataKey="uv" stroke="#3b82f6" strokeWidth={3} />
              <CartesianGrid stroke="#ccc" strokeDasharray="5 5" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
