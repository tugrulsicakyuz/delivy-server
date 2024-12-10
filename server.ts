import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname))
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Not an image! Please upload an image.'));
    }
  }
});

// Types
interface Restaurant {
  id: string;
  name: string;
  coverImage?: string;
  isActive: boolean;
  updatedAt: number;
}

interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  imageUri?: string;
}

interface Message {
  id: string;
  orderId: string;
  content: string;
  senderId: string;
  isFromUser: boolean;  // Add this
  timestamp: number;
}
interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  price: number;
}

interface Order {
  id: string;
  userId: string;
  customerName: string;
  restaurantId: string;
  restaurantName: string;
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELLED';
  totalAmount: number;
  orderItems: OrderItem[];
  createdAt: number;
}

// In-memory storage (replace with database in production)
let restaurants: Restaurant[] = [];
let tempMenus = new Map<string, { items: MenuItem[]; timestamp: number }>();
let messages = new Map<string, Message[]>(); // orderId -> messages
let orders = new Map<string, Order[]>();  // userId -> orders

// Clean up old data periodically
setInterval(() => {
  const now = Date.now();
  
  // Clean up menus older than 24 hours
  for (const [id, data] of tempMenus.entries()) {
    if (now - data.timestamp > 24 * 60 * 60 * 1000) {
      tempMenus.delete(id);
    }
  }
  
  // Clean up messages older than 3 hours
  for (const [orderId, orderMessages] of messages.entries()) {
    const filteredMessages = orderMessages.filter(
      msg => now - msg.timestamp <= 3 * 60 * 60 * 1000
    );
    if (filteredMessages.length === 0) {
      messages.delete(orderId);
    } else {
      messages.set(orderId, filteredMessages);
    }
  }
  
  // Clean up completed orders older than 24 hours
  for (const [userId, userOrders] of orders.entries()) {
    const activeOrders = userOrders.filter(order => 
      order.status !== 'DELIVERED' && order.status !== 'CANCELLED' ||
      now - order.createdAt <= 24 * 60 * 60 * 1000
    );
    if (activeOrders.length === 0) {
      orders.delete(userId);
    } else {
      orders.set(userId, activeOrders);
    }
  }
}, 15 * 60 * 1000); // Run every 15 minutes

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Restaurant endpoints
app.get('/restaurants', (req: Request, res: Response) => {
  console.log("GET /restaurants - All restaurants:", restaurants);
  
  // Only filter if no specific user type is specified
  const { type } = req.query;
  
  const restaurantsToSend = type === 'all' ? 
    restaurants : 
    restaurants.filter(r => r.isActive === true);
    
  console.log("GET /restaurants - Sending restaurants:", restaurantsToSend);
  res.json(restaurantsToSend);
});

app.get('/restaurants/:restaurantId', (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.params;
    console.log("Fetching single restaurant:", restaurantId);
    
    const restaurant = restaurants.find(r => r.id === restaurantId);
    console.log("Found restaurant:", restaurant);
    
    if (!restaurant) {
      res.status(404).json({ error: 'Restaurant not found' });
      return;
    }
    
    res.json(restaurant);
  } catch (error) {
    console.error('Error fetching restaurant:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

app.post('/restaurants', upload.single('coverImage'), (req: Request, res: Response) => {
  try {
    const { id, name, isActive } = req.body;
    console.log("Server: Creating/updating restaurant:", { id, name, isActive });
    
    if (!id || !name) {
      console.error("Server: Missing required fields");
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const existingIndex = restaurants.findIndex(r => r.id === id);
    const restaurant: Restaurant = {
      id,
      name,
      coverImage: req.file ? `/uploads/${req.file.filename}` : undefined,
      isActive: isActive === 'true' ? true : false,
      updatedAt: Date.now()
    };

    if (existingIndex >= 0) {
      restaurants[existingIndex] = restaurant;
      console.log("Server: Updated restaurant:", restaurant);
    } else {
      restaurants.push(restaurant);
      console.log("Server: Created new restaurant:", restaurant);
    }

    res.json({ success: true, restaurant });
  } catch (error) {
    console.error('Server: Restaurant creation error:', error);
    res.status(500).json({ error: 'Failed to create/update restaurant' });
  }
});

// Menu endpoints
app.post('/menus/:restaurantId', (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.params;
    const { items } = req.body;
    
    console.log("Storing menu for restaurant:", restaurantId);
    console.log("Menu items:", items);
    
    tempMenus.set(restaurantId, {
      items,
      timestamp: Date.now()
    });
    
    console.log("Current tempMenus:", Array.from(tempMenus.entries()));
    res.json({ success: true });
  } catch (error) {
    console.error('Error storing menu:', error);
    res.status(500).json({ error: 'Failed to store menu' });
  }
});

app.get('/menus/:restaurantId', (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.params;
    console.log("Menu request received for restaurant:", restaurantId);
    
    const menuData = tempMenus.get(restaurantId);
    if (!menuData) {
      console.log("No menu found for restaurant:", restaurantId);
      res.status(404).json({ error: 'Menu not found' });
      return;
    }
    
    console.log("Returning menu data:", menuData.items);
    res.json(menuData.items);
  } catch (error) {
    console.error('Error retrieving menu:', error);
    res.status(500).json({ error: 'Failed to retrieve menu' });
  }
});

// Get all orders for a user (customer or restaurant)
app.get('/orders/:userId', (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { type } = req.query;
    console.log("Fetching orders for user:", userId, "type:", type);
    
    const allOrders = Array.from(orders.values()).flat();
    
    // Filter based on type (customer or restaurant)
    const userOrders = allOrders.filter(order => 
      type === 'customer' ? order.userId === userId : order.restaurantId === userId
    );
    
    console.log("Found filtered orders:", userOrders);
    res.json(userOrders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Create or update orders
app.post('/orders/:userId', (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { orders: newOrders } = req.body;
    console.log("Storing orders for user:", userId);
    console.log("Orders data:", newOrders);
    
    orders.set(userId, newOrders);
    res.json({ success: true });
  } catch (error) {
    console.error('Error storing orders:', error);
    res.status(500).json({ error: 'Failed to store orders' });
  }
});

// Update order status
app.put('/orders/:orderId/status', (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { status, userId } = req.body;
    console.log("Updating order status:", orderId, status);
    
    const userOrders = orders.get(userId) || [];
    const orderIndex = userOrders.findIndex(order => order.id === orderId);
    
    if (orderIndex === -1) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    
    userOrders[orderIndex].status = status;
    orders.set(userId, userOrders);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Message endpoints
// Message endpoints
app.post('/messages/:orderId', (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { content, senderId, isFromUser } = req.body;
    
    console.log("New message received:", {
      orderId,
      content,
      senderId,
      isFromUser
    });
    
    const message: Message = {
      id: Math.random().toString(36).slice(2),
      orderId,
      content,
      senderId,
      isFromUser,  // Save this
      timestamp: Date.now()
    };
    
    const orderMessages = messages.get(orderId) || [];
    orderMessages.push(message);
    messages.set(orderId, orderMessages);
    
    console.log("Messages for order:", orderId, messages.get(orderId));
    
    res.json({ success: true, message });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});
app.get('/messages/:orderId', (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const orderMessages = messages.get(orderId) || [];
    res.json(orderMessages);
  } catch (error) {
    console.error('Error retrieving messages:', error);
    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

// Error handling
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something broke!' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});