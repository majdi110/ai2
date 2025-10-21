import React, { useState } from 'react';
import { CloudArrowUpIcon, LockClosedIcon, ServerIcon, CreditCardIcon, DevicePhoneMobileIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import './App.css';

function Hero() {
  return (
    <section className="hero">
      <div className="container">
        <h1>Transform Your Business with Our SaaS Solution</h1>
        <p>Experience seamless integration, powerful features, and scalable pricing tailored to your needs.</p>
        <button className="btn-primary" onClick={() => document.getElementById('contact').scrollIntoView({behavior: 'smooth'})}>
          Get Started
        </button>
      </div>
    </section>
  );
}

const featuresList = [
  {
    id: 1,
    icon: <CloudArrowUpIcon className="feature-icon" />,
    title: 'Cloud Storage',
    description: 'Securely store and access your data anywhere, anytime with our reliable cloud infrastructure.'
  },
  {
    id: 2,
    icon: <LockClosedIcon className="feature-icon" />,
    title: 'Top-notch Security',
    description: 'Keep your data safe with industry-leading encryption and compliance standards.'
  },
  {
    id: 3,
    icon: <ServerIcon className="feature-icon" />,
    title: 'Fast Servers',
    description: 'Enjoy ultra-low latency and high availability with our global server network.'
  },
  {
    id: 4,
    icon: <CreditCardIcon className="feature-icon" />,
    title: 'Flexible Billing',
    description: 'Choose plans that scale with your business needs and budget.'
  },
  {
    id: 5,
    icon: <DevicePhoneMobileIcon className="feature-icon" />,
    title: 'Mobile Friendly',
    description: 'Manage your account and data on the go with fully responsive design.'
  },
];

function Features() {
  return (
    <section className="features">
      <div className="container">
        <h2>Awesome Features</h2>
        <div className="feature-cards">
          {featuresList.map(({ id, icon, title, description }) => (
            <div key={id} className="feature-card">
              {icon}
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const pricingTiers = [
  {
    id: 1,
    name: 'Basic',
    price: '$19',
    description: 'Ideal for individuals starting out.',
    features: [
      '1 User License',
      '5GB Storage',
      'Email Support',
      'Basic Analytics'
    ]
  },
  {
    id: 2,
    name: 'Pro',
    price: '$49',
    description: 'Perfect for small teams and growing projects.',
    features: [
      'Up to 10 Users',
      '50GB Storage',
      'Priority Email Support',
      'Advanced Analytics'
    ],
    popular: true
  },
  {
    id: 3,
    name: 'Enterprise',
    price: 'Contact Us',
    description: 'Tailored solutions for larger organizations.',
    features: [
      'Unlimited Users',
      'Unlimited Storage',
      'Dedicated Support',
      'Custom Analytics'
    ]
  }
];

function Pricing() {
  return (
    <section className="pricing">
      <div className="container">
        <h2>Pricing Plans</h2>
        <div className="pricing-table">
          {pricingTiers.map(({ id, name, price, description, features, popular }) => (
            <div key={id} className={`pricing-tier${popular ? ' popular' : ''}`}>
              <div className="tier-name">{name}</div>
              <div className="tier-price">{price}{price !== 'Contact Us' && <span style={{fontSize: '1rem', fontWeight: '400'}}> / mo</span>}</div>
              <div className="tier-desc">{description}</div>
              <ul className="tier-features">
                {features.map((feature, i) => (
                  <li key={i}>{feature}</li>
                ))}
              </ul>
              <button className="btn-select">{price === 'Contact Us' ? 'Contact Sales' : 'Select'}</button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Contact() {
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });
  const [sent, setSent] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // Basic validation
    if (!formData.name || !formData.email || !formData.message) {
      alert('Please fill in all fields');
      return;
    }
    // Here would be submission logic (e.g. API call)
    setSent(true);
    setFormData({ name: '', email: '', message: '' });
  };

  return (
    <section className="contact" id="contact">
      <div className="container">
        <h2>Contact Us</h2>
        {sent && <p style={{color: '#10b981', textAlign: 'center', marginBottom: '1rem'}}>Thank you! Your message has been sent.</p>}
        <form className="contact-form" onSubmit={handleSubmit} noValidate>
          <label htmlFor="name">Name</label>
          <input
            type="text"
            id="name"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="Your full name"
            required
          />

          <label htmlFor="email">Email</label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="you@example.com"
            required
          />

          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            name="message"
            value={formData.message}
            onChange={handleChange}
            placeholder="How can we help you?"
            required
          />

          <button type="submit">Send Message</button>
        </form>
      </div>
    </section>
  );
}

function App() {
  return (
    <>
      <Hero />
      <Features />
      <Pricing />
      <Contact />
    </>
  );
}

export default App;
