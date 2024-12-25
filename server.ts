import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Server as WebSocketServer } from 'ws';
import http from 'http';

// Initialize express and create HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Constants
const THREE_HOURS = 3 * 60 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

// Middleware setup with increased limits
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for image uploads with updated settings
const storage = multer.diskStorage({
  destination: (req: Express.Request, file: Express.Multer.File, cb: Function) => {
    cb(null, uploadsDir);
  },
  filename: (req: Express.Request, file: Express.Multer.File, cb: Function) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `image-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for files
    fieldSize: 25 * 1024 * 1024 // 25MB limit for form fields
  },
  fileFilter: (req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (!file.mimetype) {
      cb(new Error('No mime type provided'));
      return;
    }
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Not an image! Please upload an image.'));
    }
  }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Type definitions
interface ImageRecord {
  filename: string;
  timestamp: number;
}

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
  category: string;
  imageUri?: string;
  isAvailable: boolean;
  updatedAt: number;
}

interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  price: number;
}

type OrderStatus = 
  | 'PENDING' 
  | 'ACCEPTED' 
  | 'PREPARING' 
  | 'READY' 
  | 'PICKED_UP' 
  | 'ON_WAY' 
  | 'DELIVERED' 
  | 'CANCELLED';

interface Order {
  id: string;
  userId: string;
  customerName: string;
  restaurantId: string;
  restaurantName: string;
  status: OrderStatus;
  totalAmount: number;
  orderItems: OrderItem[];
  deliveryAddress: string;
  courierId?: string;
  courierName?: string;
  createdAt: number;
}

interface Message {
  id: string;
  orderId: string;
  content: string;
  senderId: string;
  isFromUser: boolean;
  timestamp: number;
  chatType: 'RESTAURANT_CHAT' | 'COURIER_CHAT';
  delivered: boolean;
}

interface Courier {
  id: string;
  fullName: string;
  phone: string;
  vehicleInfo: string;
  isAvailable: boolean;
  currentOrderId?: string;
  totalDeliveries: number;
  totalEarnings: number;
  lastActive: number;
}

// In-memory storage
let restaurants: Restaurant[] = [];
let tempMenus = new Map<string, { items: MenuItem[]; timestamp: number }>();
let messages = new Map<string, Message[]>();
let orders = new Map<string, Order[]>();
let imageRecords: ImageRecord[] = [];
let couriers = new Map<string, Courier>();
// Enhanced error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
    return res.status(400).json({ error: err.message });
  }
  
  if (err.name === 'PayloadTooLargeError') {
    console.error('Payload too large error:', err);
    return res.status(413).json({ error: 'Request too large' });
  }
  
  console.error('Unexpected error:', err);
  next(err);
});

// WebSocket setup
wss.on('connection', (ws) => {
  console.log('New WebSocket connection established');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received WebSocket message:', data);

      // Broadcast message to all clients except sender
      wss.clients.forEach((client) => {
        if (client !== ws) {
          client.send(JSON.stringify({
            type: 'message',
            data: data
          }));
        }
      });
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Restaurant endpoints
app.get('/restaurants', (req: Request, res: Response) => {
  try {
    console.log('GET /restaurants - Query:', req.query);
    const { type } = req.query;
    const restaurantsToSend = type === 'all' ? 
      restaurants : 
      restaurants.filter(r => r.isActive === true);
    
    console.log(`Sending ${restaurantsToSend.length} restaurants`);
    res.json(restaurantsToSend);
  } catch (error) {
    console.error('Error fetching restaurants:', error);
    res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});

app.get('/restaurants/:restaurantId', (req: Request, res: Response) => {
  try {
    console.log('GET /restaurants/:restaurantId - Params:', req.params);
    const { restaurantId } = req.params;
    const restaurant = restaurants.find(r => r.id === restaurantId);
    
    if (!restaurant) {
      console.log(`Restaurant not found: ${restaurantId}`);
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    
    console.log('Found restaurant:', restaurant);
    res.json(restaurant);
  } catch (error) {
    console.error('Error fetching restaurant:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});


app.post('/restaurants', upload.single('coverImage'), (req: Request, res: Response) => {
  try {
    console.log('POST /restaurants - Body:', req.body);
    
    // If there's only a file being uploaded (no other fields)
    if (req.file && Object.keys(req.body).length === 0) {
      const imageUrl = `/uploads/${req.file.filename}`;
      return res.json({ success: true, imageUrl });
    }

    const { id, name, isActive } = req.body;

    // Rest of restaurant update logic
    if (!id || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingIndex = restaurants.findIndex(r => r.id === id);
    let existingCoverImage;
    
    if (existingIndex >= 0) {
      existingCoverImage = restaurants[existingIndex].coverImage;
    }

    const restaurant: Restaurant = {
      id,
      name,
      coverImage: req.file ? `/uploads/${(req.file as Express.Multer.File).filename}` : existingCoverImage,
      isActive: isActive === 'true',
      updatedAt: Date.now()
    };

    if (existingIndex >= 0) {
      if (req.file && existingCoverImage) {
        try {
          const oldImagePath = path.join(uploadsDir, path.basename(existingCoverImage));
          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
            console.log('Deleted old image:', existingCoverImage);
          }
        } catch (error) {
          console.error('Error deleting old image:', error);
        }
      }
      
      restaurants[existingIndex] = restaurant;
      console.log('Updated restaurant:', restaurant);
    } else {
      restaurants.push(restaurant);
      console.log('Created new restaurant:', restaurant);
    }

    res.json({ success: true, restaurant });
  } catch (error) {
    console.error('Restaurant creation error:', error);
    res.status(500).json({ error: 'Failed to create/update restaurant' });
  }
});

// Menu endpoints
app.post('/menus/:restaurantId', (req: Request, res: Response) => {
  try {
    console.log('POST /menus/:restaurantId - Params:', req.params);
    const { restaurantId } = req.params;
    const { items } = req.body;
    
    if (!Array.isArray(items)) {
      console.log('Invalid menu items format:', items);
      return res.status(400).json({ error: 'Invalid menu items format' });
    }
    
    console.log(`Processing ${items.length} menu items for restaurant ${restaurantId}`);
    const itemsWithTimestamp = items.map(item => ({
      ...item,
      updatedAt: Date.now()
    }));

    tempMenus.set(restaurantId, {
      items: itemsWithTimestamp,
      timestamp: Date.now()
    });
    
    console.log('Menu updated successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('Error storing menu:', error);
    res.status(500).json({ error: 'Failed to store menu' });
  }
});

app.get('/menus/:restaurantId', (req: Request, res: Response) => {
  try {
    console.log('GET /menus/:restaurantId - Params:', req.params);
    const { restaurantId } = req.params;
    const menuData = tempMenus.get(restaurantId);
    
    if (!menuData || Date.now() - menuData.timestamp > TWENTY_FOUR_HOURS) {
      console.log(`Menu not found or expired for restaurant ${restaurantId}`);
      tempMenus.delete(restaurantId);
      return res.status(404).json({ error: 'Menu not found or expired' });
    }
    
    console.log(`Returning ${menuData.items.length} menu items`);
    res.json(menuData.items);
  } catch (error) {
    console.error('Error fetching menu:', error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});
app.get('/orders/available', (req: Request, res: Response) => {
  try {
    const allOrders = Array.from(orders.values()).flat();
    const availableOrders = allOrders.filter(order => 
      order.status === 'READY' && !order.courierId
    );
    res.json(availableOrders);
  } catch (error) {
    console.error('Error fetching available orders:', error);
    res.status(500).json({ error: 'Failed to fetch available orders' });
  }
});
// Order endpoints
app.get('/orders/:userId', (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { type } = req.query;
    
    const allOrders = Array.from(orders.values()).flat();
    console.log("ALL ORDERS BEFORE FILTER:", {
      ordersMapSize: orders.size,
      allOrdersLength: allOrders.length,
      orders: allOrders
    });

    let userOrders;

    if (type === 'customer') {
      userOrders = allOrders.filter(order => order.userId === userId);
    } else if (type === 'courier') {
      console.log("CHECKING COURIER ORDERS:", {
        userId,
        type,
        orderCount: allOrders.length,
        courierOrders: allOrders.filter(order => order.courierId === userId)
      });
      userOrders = allOrders.filter(order => order.courierId === userId);
    } else {
      userOrders = allOrders.filter(order => order.restaurantId === userId);
    }

    userOrders = userOrders.filter(order => 
      Date.now() - order.createdAt <= TWENTY_FOUR_HOURS
    );
    
    console.log(`Returning ${userOrders.length} orders for user ${userId} with type ${type}`);
    console.log("FINAL ORDERS:", userOrders);
    res.json(userOrders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});



app.post('/orders/:userId', (req: Request, res: Response) => {
  try {
    console.log('POST /orders/:userId - Params:', req.params);
    const { userId } = req.params;
    const { orders: newOrders } = req.body;
    
    if (!Array.isArray(newOrders)) {
      console.log('Invalid orders format:', newOrders);
      return res.status(400).json({ error: 'Invalid orders format' });
    }

    console.log(`Processing ${newOrders.length} new orders`);
    const existingOrders = orders.get(userId) || [];
    const updatedOrders = [...existingOrders, ...newOrders];
    orders.set(userId, updatedOrders);

    // Broadcast new order via WebSocket
    wss.clients.forEach((client) => {
      client.send(JSON.stringify({
        type: 'new_order',
        data: newOrders[0]  // Broadcasting first new order
      }));
    });
    
    console.log('Orders created successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('Error creating orders:', error);
    res.status(500).json({ error: 'Failed to create orders' });
  }
});

app.put('/orders/:orderId/status', (req: Request, res: Response) => {
  try {
    console.log('PUT /orders/:orderId/status - Params:', req.params, 'Body:', req.body);
    const { orderId } = req.params;
    const { status, userId, courierId } = req.body;
    
    let found = false;
    let updatedOrder: Order | null = null;

    orders.forEach((userOrders, key) => {
      const orderIndex = userOrders.findIndex(order => order.id === orderId);
      if (orderIndex !== -1) {
        // Update status and courier info
        userOrders[orderIndex] = {
          ...userOrders[orderIndex],
          status,
          courierId: courierId || userOrders[orderIndex].courierId
        };
        updatedOrder = userOrders[orderIndex];
        orders.set(key, userOrders);
        found = true;
      }
    });

    if (!found) {
      console.log(`Order not found: ${orderId}`);
      return res.status(404).json({ error: 'Order not found' });
    }

    // Broadcast status update via WebSocket
    if (updatedOrder) {
      console.log('Broadcasting order update:', { orderId, status });
      wss.clients.forEach((client) => {
        client.send(JSON.stringify({
          type: 'order_update',
          data: {
            orderId,
            status,
            updatedOrder
          }
        }));
      });
    }
    
    console.log('Order status updated successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Message endpoints
// In server.ts, add this function after receiving a message:
app.post('/messages/:orderId', (req: Request, res: Response) => {
  try {
    console.log('POST /messages/:orderId - Params:', req.params, 'Body:', req.body);
    const { orderId } = req.params;
    const { content, senderId, isFromUser, chatType } = req.body;
    
    if (!content || !senderId || !chatType) {
      console.log('Missing required fields:', { content, senderId, chatType });
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const message: Message = {
      id: Math.random().toString(36).slice(2),
      orderId,
      content,
      senderId,
      isFromUser,
      chatType,
      timestamp: Date.now(),
      delivered: false  // Add this flag
    };
    
    const orderMessages = messages.get(orderId) || [];
    orderMessages.push(message);
    messages.set(orderId, orderMessages);

    // Broadcast message
    wss.clients.forEach((client) => {
      client.send(JSON.stringify({
        type: 'new_message',
        data: message
      }));
    });

    // We should add a delivery confirmation mechanism
    wss.on('message', (data) => {
      const parsedData = JSON.parse(data.toString());
      if (parsedData.type === 'message_delivered' && parsedData.messageId === message.id) {
        // Now we can safely delete the delivered message
        const updatedMessages = orderMessages.filter(msg => msg.id !== message.id);
        messages.set(orderId, updatedMessages);
      }
    });
    
    res.json({ success: true, message });
  } catch (error) {
    console.error('Error creating message:', error);
    res.status(500).json({ error: 'Failed to create message' });
  }
});

app.get('/messages/:orderId', (req: Request, res: Response) => {
  try {
    console.log('GET /messages/:orderId - Params:', req.params, 'Query:', req.query);
    const { orderId } = req.params;
    const { type } = req.query;  // 'RESTAURANT_CHAT' or 'COURIER_CHAT'
    
    const orderMessages = messages.get(orderId) || [];
    const filteredMessages = type ? 
      orderMessages.filter(msg => msg.chatType === type) : 
      orderMessages;
    
    const recentMessages = filteredMessages.filter(
      msg => Date.now() - msg.timestamp <= THREE_HOURS
    );
    
    if (recentMessages.length !== orderMessages.length) {
      console.log(`Cleaned up ${orderMessages.length - recentMessages.length} old messages`);
      messages.set(orderId, recentMessages);
    }
    
    console.log(`Returning ${recentMessages.length} messages`);
    res.json(recentMessages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Cleanup old data every 15 minutes
setInterval(() => {
  const now = Date.now();
  console.log('Starting cleanup routine');
  
  // Clean menus older than 24 hours
  let menuCount = 0;
  for (const [id, data] of tempMenus.entries()) {
    if (now - data.timestamp > TWENTY_FOUR_HOURS) {
      tempMenus.delete(id);
      menuCount++;
    }
  }
  console.log(`Cleaned up ${menuCount} expired menus`);
  
  // Clean messages older than 3 hours
  let messageCount = 0;
  for (const [orderId, orderMessages] of messages.entries()) {
    const filteredMessages = orderMessages.filter(
      msg => now - msg.timestamp <= THREE_HOURS
    );
    if (filteredMessages.length === 0) {
      messages.delete(orderId);
    } else {
      messages.set(orderId, filteredMessages);
    }
    messageCount += orderMessages.length - filteredMessages.length;
  }
  console.log(`Cleaned up ${messageCount} expired messages`);
  
  // Clean completed orders older than 24 hours
  let orderCount = 0;
  for (const [userId, userOrders] of orders.entries()) {
    const activeOrders = userOrders.filter(order => 
      order.status !== 'DELIVERED' && 
      order.status !== 'CANCELLED' ||
      now - order.createdAt <= TWENTY_FOUR_HOURS
    );
    if (activeOrders.length === 0) {
      orders.delete(userId);
    } else {
      orders.set(userId, activeOrders);
    }
    orderCount += userOrders.length - activeOrders.length;
  }
  console.log(`Cleaned up ${orderCount} expired orders`);

  // Clean old images
  let imageCount = 0;
  const oldImages = imageRecords.filter(record => now - record.timestamp > THREE_HOURS);
  for (const image of oldImages) {
    const imagePath = path.join(uploadsDir, image.filename);
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
        imageCount++;
      }
    } catch (error) {
      console.error(`Error deleting image ${image.filename}:`, error);
    }
  }
  imageRecords = imageRecords.filter(record => now - record.timestamp <= THREE_HOURS);
  console.log(`Cleaned up ${imageCount} expired images`);
  
  // Clean inactive couriers
  let courierCount = 0;
  for (const [id, courier] of couriers.entries()) {
    if (now - courier.lastActive > TWENTY_FOUR_HOURS) {
      couriers.delete(id);
      courierCount++;
    }
  }
  console.log(`Cleaned up ${courierCount} inactive couriers`);
}, FIFTEEN_MINUTES);

// Start the server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`WebSocket server is running on ws://localhost:${PORT}`);
  console.log(`File uploads will be stored in: ${uploadsDir}`);
});