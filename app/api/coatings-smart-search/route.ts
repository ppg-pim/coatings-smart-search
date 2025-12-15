import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

// Types
type ProductRecord = Record<string, any>

interface AIQueryPlan {
  intent: 'comparison' | 'lookup' | 'list' | 'count' | 'analytical'
  searchTerms: string[]
  filters?: {
    family?: string
    productType?: string
    productModel?: string
  }
  requiresMultipleProducts: boolean
  explanation: string
}

interface FilterCache {
  families: string[]
  productTypes: string[]
  productModels: string[]
  timestamp: number
  ttl: number
}

// 🎯 OPTIMIZED TOKEN LIMITS
const MAX_TOKENS = 30000
const MAX_INPUT_TOKENS = 20000
const MAX_DETAILED_PRODUCTS = 20
const MAX_SUMMARY_PRODUCTS = 100
const MAX_FIELD_LENGTH = 200

// 🎯 Cache for database schema
let schemaCache: string[] | null = null

// In-memory cache
let filterCache: FilterCache | null = null
const CACHE_TTL = 1000 * 60 * 60 * 24

// 🎯 NEW: Priority search fields (indexed fields for better performance)
const PRIORITY_SEARCH_FIELDS = [
  'Product_Type',
  'Product_Name', 
  'Product_Model',
  'family',
  'sku'
]

// 🎯 NEW: Secondary search fields (searched only if priority fields fail)
const SECONDARY_SEARCH_FIELDS = [
  'Product_Description',
  'Application',
  'Notes'
]

// Get actual database columns
async function getDatabaseColumns(): Promise<string[]> {
  if (schemaCache) {
    return schemaCache
  }
  
  try {
    const { data, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)
    
    if (error || !data || data.length === 0) {
      console.error('❌ Failed to get database schema')
      return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
    }
    
    const columns = Object.keys(data[0])
    schemaCache = columns
    console.log(`✅ Database columns detected: ${columns.length} fields`)
    
    return columns
  } catch (error) {
    console.error('❌ Error getting database columns:', error)
    return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
  }
}

// Clean product data
function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}
  
  Object.entries(product).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      if (typeof value === 'string') {
        let cleanedValue = value
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<li>/gi, '• ')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&reg;/gi, '®')
          .replace(/&trade;/gi, '™')
          .replace(/&copy;/gi, '©')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/&rsquo;/gi, "'")
          .replace(/&lsquo;/gi, "'")
          .replace(/&rdquo;/gi, '"')
          .replace(/&ldquo;/gi, '"')
          .replace(/&deg;/gi, '°')
          .replace(/&plusmn;/gi, '±')
          .replace(/&times;/gi, '×')
          .replace(/&divide;/gi, '÷')
          .replace(/&ndash;/gi, '–')
          .replace(/&mdash;/gi, '—')
          .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
          .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        
        if (cleanedValue !== '') {
          cleaned[key] = cleanedValue
        }
      } else {
        cleaned[key] = value
      }
    }
  })
  
  return cleaned
}

// Fetch ALL distinct values with pagination
async function fetchAllDistinctValues(columnName: string): Promise<string[]> {
  console.log(`  📊 Fetching all distinct values for: ${columnName}`)
  
  const allValues = new Set<string>()
  let page = 0
  const pageSize = 1000
  let hasMore = true
  
  while (hasMore) {
    const from = page * pageSize
    const to = from + pageSize - 1
    
    try {
      const { data, error } = await supabase
        .from('coatings')
        .select(columnName)
        .not(columnName, 'is', null)
        .neq(columnName, '')
        .order(columnName)
        .range(from, to)
      
      if (error || !data || data.length === 0) break
      
      data.forEach((row: any) => {
        const value = row[columnName]
        if (value && typeof value === 'string' && value.trim() !== '') {
          allValues.add(value.trim())
        }
      })
      
      if (data.length < pageSize) {
        hasMore = false
      } else {
        page++
      }
      
      if (page > 100) break
      
    } catch (err) {
      console.error(`  ❌ Exception fetching ${columnName}:`, err)
      break
    }
  }
  
  const sortedValues = Array.from(allValues).sort()
  console.log(`  ✅ ${columnName}: ${sortedValues.length} unique values`)
  
  return sortedValues
}

// Get filter options with caching
async function getFilterOptions(forceRefresh: boolean = false): Promise<any> {
  if (!forceRefresh && filterCache) {
    const now = Date.now()
    const cacheAge = now - filterCache.timestamp
    
    if (cacheAge < filterCache.ttl) {
      return {
        success: true,
        cached: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }
  }
  
  try {
    const [families, types, models] = await Promise.all([
      fetchAllDistinctValues('family'),
      fetchAllDistinctValues('Product_Type'),
      fetchAllDistinctValues('Product_Model')
    ])
    
    filterCache = {
      families,
      productTypes: types,
      productModels: models,
      timestamp: Date.now(),
      ttl: CACHE_TTL
    }
    
    return {
      success: true,
      cached: false,
      filterOptions: {
        families,
        productTypes: types,
        productModels: models
      }
    }
  } catch (error: any) {
    console.error('❌ Error fetching filter options:', error)
    
    if (filterCache) {
      return {
        success: true,
        cached: true,
        expired: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }
    
    return {
      success: false,
      error: 'Failed to fetch filter options',
      filterOptions: { families: [], productTypes: [], productModels: [] }
    }
  }
}

// Get database schema (minimal)
async function getDatabaseSchema(): Promise<string> {
  const columns = await getDatabaseColumns()
  return `Key Fields: ${columns.slice(0, 15).join(', ')}`
}

// AI Query Planner (shortened prompt)
async function planQuery(userQuery: string, appliedFilters: any): Promise<AIQueryPlan> {
  console.log(`🤖 AI analyzing query: "${userQuery}"`)
  
  const systemPrompt = `Analyze user query and return JSON:
{
  "intent": "comparison|lookup|list|count|analytical",
  "searchTerms": ["term1", "term2"],
  "filters": {"productType": "optional", "productModel": "optional", "family": "optional"},
  "requiresMultipleProducts": true/false,
  "explanation": "brief explanation"
}

Intent types:
- comparison: Compare 2+ products
- lookup: Info about specific product(s)
- list: All products matching criteria
- count: How many products
- analytical: Recommendations/advice`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${userQuery}"\nFilters: ${JSON.stringify(appliedFilters)}` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
    
    const plan = JSON.parse(completion.choices[0].message.content || '{}') as AIQueryPlan
    console.log(`✅ AI Query Plan:`, plan)
    return plan
  } catch (error) {
    console.error('❌ AI planning failed:', error)
    return {
      intent: 'lookup',
      searchTerms: [userQuery],
      requiresMultipleProducts: false,
      explanation: 'Fallback'
    }
  }
}

// 🎯 OPTIMIZED: Progressive search strategy with Product_Model support
async function executeSmartSearch(plan: AIQueryPlan, appliedFilters: any): Promise<ProductRecord[]> {
  console.log(`⚡ Executing smart search for: ${plan.searchTerms.join(', ')}`)
  
  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()
  
  // Get available columns
  const allColumns = await getDatabaseColumns()
  
  // Filter priority fields to only existing ones
  const availablePriorityFields = PRIORITY_SEARCH_FIELDS.filter(f => allColumns.includes(f))
  const availableSecondaryFields = SECONDARY_SEARCH_FIELDS.filter(f => allColumns.includes(f))
  
  console.log(`🔍 Priority fields: ${availablePriorityFields.join(', ')}`)
  console.log(`🔍 Secondary fields: ${availableSecondaryFields.join(', ')}`)
  
  try {
	// 🎯 STRATEGY 1: Ultra-comprehensive search for list/count queries
	if ((plan.intent === 'list' || plan.intent === 'count') && plan.searchTerms.length > 0) {
	  const searchTerm = plan.searchTerms.join(' ')
	  
	  console.log(`📊 Strategy 1: Ultra-comprehensive search for "${searchTerm}"...`)
	  
	  try {
		let query = supabase.from('coatings').select('*')
		
		// Apply user filters first
		if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
		if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
		if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)
		
		// 🎯 Split search term into individual words
		const searchWords = searchTerm.split(/\s+/).filter(w => w.length > 2)
		
		// 🧪 DIAGNOSTIC: Check search words
		console.log(`🧪 DIAGNOSTIC: searchWords =`, searchWords)
		console.log(`🧪 DIAGNOSTIC: searchWords.length =`, searchWords.length)
		console.log(`🧪 DIAGNOSTIC: Will enter Strategy 1B? ${searchWords.length > 1}`)

		// Build search fields list
		const searchFields = []
		if (allColumns.includes('Product_Type')) searchFields.push('Product_Type')
		if (allColumns.includes('Product_Model')) searchFields.push('Product_Model')
		if (allColumns.includes('Product_Name')) searchFields.push('Product_Name')
		if (allColumns.includes('family')) searchFields.push('family')
		if (allColumns.includes('sku')) searchFields.push('sku')
		if (allColumns.includes('Product_Description')) searchFields.push('Product_Description')
		if (allColumns.includes('Application')) searchFields.push('Application')
		
		// 🎯 STRATEGY 1A: Try exact phrase match first (with timeout protection)
		if (searchFields.length > 0) {
		  const phraseConditions = searchFields
			.map(field => `${field}.ilike.%${searchTerm}%`)
			.join(',')
		  
		  query = query.or(phraseConditions)
		  console.log(`🔍 Strategy 1A: Searching ${searchFields.length} fields for exact phrase: "${searchTerm}"`)
		}
		
		const { data, error } = await query.limit(1000)
		
		console.log(`📊 Strategy 1A Results:`)
		console.log(`  - Found: ${data?.length || 0} products`)
		console.log(`  - Error: ${error ? error.message : 'none'}`)
		if (data && data.length > 0) {
		  console.log(`  - Sample Product_Models:`, data.slice(0, 5).map(p => p.Product_Model))
		}
		
		if (!error && data && data.length > 0) {
		  console.log(`✅ Strategy 1A found ${data.length} products with exact phrase`)
		  
		  // Deduplicate
		  data.forEach((item: any) => {
			const id = item.id || item.sku || JSON.stringify(item)
			if (!seenIds.has(id)) {
			  seenIds.add(id)
			  allResults.push(item)
			}
		  })
		  
		  return allResults
		}
		
		// 🎯 STRATEGY 1B: If phrase search failed/timed out, search for LEAST COMMON word first
		if (searchWords.length > 1) {
		  console.log(`⚠️ Phrase search failed, trying optimized multi-word search: ${searchWords.join(' + ')}`)
		  
		  try {
			// 🎯 STRATEGY: Search for the SECOND word first (usually less common)
			// For "Military Thinner", search "Thinner" first to get smaller result set
			const searchWord = searchWords[searchWords.length - 1] // Use last word (usually more specific)
			
			console.log(`🔍 Searching Product_Model for "${searchWord}" (more specific term)...`)
			
			let modelQuery = supabase.from('coatings').select('*')
			
			// Apply filters
			if (appliedFilters.family) modelQuery = modelQuery.eq('family', appliedFilters.family)
			if (appliedFilters.productType) modelQuery = modelQuery.eq('Product_Type', appliedFilters.productType)
			if (appliedFilters.productModel) modelQuery = modelQuery.eq('Product_Model', appliedFilters.productModel)
			
			// Search for the more specific word
			modelQuery = modelQuery.ilike('Product_Model', `%${searchWord}%`).limit(5000)
			
			const { data: modelData, error: modelError } = await modelQuery
			
			console.log(`📊 Product_Model search for "${searchWord}": ${modelData?.length || 0} products`)
			console.log(`📊 Error: ${modelError ? modelError.message : 'none'}`)
			
			if (!modelError && modelData && modelData.length > 0) {
			  // Log sample before filtering
			  console.log(`📊 Sample products before filtering:`)
			  modelData.slice(0, 5).forEach((p, i) => {
				console.log(`  ${i + 1}. ${p.Product_Model}`)
			  })
			  
			  // Client-side filter: Keep only products where Product_Model contains ALL words
			  const filteredProducts = modelData.filter(product => {
				const modelValue = product.Product_Model
				if (!modelValue) return false
				
				const modelLower = String(modelValue).toLowerCase()
				
				// Check if Product_Model contains ALL search words
				const hasAllWords = searchWords.every(word => {
				  const wordLower = word.toLowerCase()
				  const hasWord = modelLower.includes(wordLower)
				  return hasWord
				})
				
				return hasAllWords
			  })
			  
			  console.log(`✅ After filtering: ${filteredProducts.length} products have ALL words in Product_Model`)
			  
			  if (filteredProducts.length > 0) {
				console.log(`  - Matches:`)
				filteredProducts.slice(0, 10).forEach((p, idx) => {
				  console.log(`    ${idx + 1}. ${p.sku} - ${p.Product_Model}`)
				})
				
				filteredProducts.forEach((item: any) => {
				  const id = item.id || item.sku || JSON.stringify(item)
				  if (!seenIds.has(id)) {
					seenIds.add(id)
					allResults.push(item)
				  }
				})
				
				console.log(`✅ Strategy 1B returning ${allResults.length} results`)
				return allResults
			  } else {
				console.log(`⚠️ No products matched ALL words after filtering`)
				console.log(`🧪 DEBUG: First 3 products that didn't match:`)
				modelData.slice(0, 3).forEach((p, i) => {
				  console.log(`  ${i + 1}. Product_Model: "${p.Product_Model}"`)
				  console.log(`     Checking for words: ${searchWords.join(', ')}`)
				  searchWords.forEach(word => {
					const has = String(p.Product_Model || '').toLowerCase().includes(word.toLowerCase())
					console.log(`     - Contains "${word}": ${has}`)
				  })
				})
			  }
			} else if (modelError) {
			  console.error(`❌ Product_Model search error:`, modelError)
			}
			
			// If Product_Model search failed, try Product_Type with same strategy
			console.log(`🔍 Product_Model search yielded no results, trying Product_Type for "${searchWord}"...`)
			
			let typeQuery = supabase.from('coatings').select('*')
			
			// Apply filters
			if (appliedFilters.family) typeQuery = typeQuery.eq('family', appliedFilters.family)
			if (appliedFilters.productType) typeQuery = typeQuery.eq('Product_Type', appliedFilters.productType)
			if (appliedFilters.productModel) typeQuery = typeQuery.eq('Product_Model', appliedFilters.productModel)
			
			typeQuery = typeQuery.ilike('Product_Type', `%${searchWord}%`).limit(5000)
			
			const { data: typeData, error: typeError } = await typeQuery
			
			console.log(`📊 Product_Type search: ${typeData?.length || 0} products`)
			
			if (!typeError && typeData && typeData.length > 0) {
			  const filteredByType = typeData.filter(product => {
				const typeValue = product.Product_Type
				if (!typeValue) return false
				
				const typeLower = String(typeValue).toLowerCase()
				return searchWords.every(word => typeLower.includes(word.toLowerCase()))
			  })
			  
			  console.log(`✅ After filtering Product_Type: ${filteredByType.length} products`)
			  
			  if (filteredByType.length > 0) {
				filteredByType.forEach((item: any) => {
				  const id = item.id || item.sku || JSON.stringify(item)
				  if (!seenIds.has(id)) {
					seenIds.add(id)
					allResults.push(item)
				  }
				})
				
				return allResults
			  }
			}
			
		  } catch (err) {
			console.error(`❌ Strategy 1B failed:`, err)
		  }
		} else {
		  console.log(`ℹ️ Only one search word, skipping Strategy 1B`)
		}		
		console.log(`⚠️ Strategy 1 found 0 products, trying Strategy 2...`)
	  } catch (err) {
		console.error(`❌ Strategy 1 failed:`, err)
		console.error(`❌ Stack trace:`, err instanceof Error ? err.stack : 'No stack')
	  }
	}
    
	// 🎯 STRATEGY 2: Search ALL priority fields (comprehensive) with AND logic
	console.log(`📊 Strategy 2: Searching all priority fields with AND logic...`)

	// Split all search terms into words
	const allWords = plan.searchTerms.flatMap(term => 
	  term.trim().split(/\s+/).filter(w => w.length > 2)
	)

	if (allWords.length > 0) {
	  try {
		let query = supabase.from('coatings').select('*')
		
		// Apply filters
		if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
		if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
		if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)
		
		// Search for first word to get base set
		const firstWordConditions = availablePriorityFields
		  .map(field => `${field}.ilike.%${allWords[0]}%`)
		  .join(',')
		
		if (firstWordConditions) {
		  query = query.or(firstWordConditions)
		}
		
		query = query.limit(1000)
		
		const { data, error } = await query
		
		if (!error && data && data.length > 0) {
		  console.log(`✅ Strategy 2 found ${data.length} products for first word "${allWords[0]}"`)
		  
			// Filter to keep only products where ANY SINGLE FIELD contains ALL words
			const filteredProducts = data.filter(product => {
			  return availablePriorityFields.some(field => {
				const fieldValue = product[field]
				if (!fieldValue) return false
				
				const fieldLower = String(fieldValue).toLowerCase()
				
				// Check if this field contains ALL search words
				return allWords.every(word => fieldLower.includes(word.toLowerCase()))
			  })
			})
		  
		  console.log(`✅ After AND filtering: ${filteredProducts.length} products contain ALL words`)
		  
		  filteredProducts.forEach((item: any) => {
			const id = item.id || item.sku || JSON.stringify(item)
			if (!seenIds.has(id)) {
			  seenIds.add(id)
			  allResults.push(item)
			}
		  })
		}
	  } catch (err) {
		console.error(`❌ Strategy 2 failed:`, err)
	  }
	}

	// If we found results, return them
	if (allResults.length > 0) {
	  console.log(`✅ Total results from Strategy 2: ${allResults.length}`)
	  return allResults
	}
    
    // 🎯 STRATEGY 3: Try secondary fields (slower, only if needed)
    console.log(`📊 Strategy 3: Searching secondary fields...`)
    
    for (const term of plan.searchTerms) {
      const searchTerm = term.trim()
      
      // Try each secondary field individually to avoid timeout
      for (const field of availableSecondaryFields) {
        try {
          let query = supabase.from('coatings').select('*')
          
          // Apply filters
          if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
          if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
          if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)
          
          query = query.ilike(field, `%${searchTerm}%`).limit(50)
          
          const { data, error } = await query
          
          if (!error && data && data.length > 0) {
            console.log(`✅ Found ${data.length} products in ${field}`)
            data.forEach((item: any) => {
              const id = item.id || item.sku || JSON.stringify(item)
              if (!seenIds.has(id)) {
                seenIds.add(id)
                allResults.push(item)
              }
            })
          }
        } catch (err) {
          console.error(`❌ Error searching ${field}:`, err)
        }
      }
    }
    
    console.log(`✅ Total results: ${allResults.length}`)
    return allResults
    
  } 
  catch (error) {
    console.error('❌ Search execution error:', error)
    return []
  }
  
	// 🎯 STRATEGY 4: Exact match on Product_Model (fallback for specific model searches)
	if (allResults.length === 0 && allColumns.includes('Product_Model')) {
	  console.log(`📊 Strategy 4: Trying exact Product_Model matches...`)
	  
	  for (const term of plan.searchTerms) {
		try {
		  let query = supabase.from('coatings').select('*')
		  
		  // Apply filters
		  if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
		  if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
		  if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)
		  
		  // Try exact match (case-insensitive)
		  query = query.ilike('Product_Model', term)
		  
		  const { data, error } = await query.limit(100)
		  
		  if (!error && data && data !== null && data.length > 0) {
			console.log(`✅ Strategy 4 found ${data.length} products with exact Product_Model match`)
			data.forEach((item: any) => {
			  const id = item.id || item.sku || JSON.stringify(item)
			  if (!seenIds.has(id)) {
				seenIds.add(id)
				allResults.push(item)
			  }
			})
		  }
		} catch (err) {
		  console.error(`❌ Strategy 4 failed:`, err)
		}
	  }
	}
}

// Create comprehensive product list table
function createProductListTable(products: ProductRecord[]): string {
  const headers = '| # | Family | SKU | Product Name | Type | Model |'
  const separator = '|---|--------|-----|--------------|------|-------|'
  
  const rows = products.map((p, i) => {
    const family = (p.family || 'N/A').substring(0, 20)
    const sku = (p.sku || 'N/A').substring(0, 15)
    const name = (p.Product_Name || 'N/A').substring(0, 40)
    const type = (p.Product_Type || 'N/A').substring(0, 15)
    const model = (p.Product_Model || 'N/A').substring(0, 15)
    
    return `| ${i + 1} | ${family} | ${sku} | ${name} | ${type} | ${model} |`
  })
  
  return [headers, separator, ...rows].join('\n')
}

// Ultra-compact summary
function createCompactSummary(products: ProductRecord[]): string {
  const summaries = products.slice(0, MAX_SUMMARY_PRODUCTS).map((p, i) => {
    return `${i + 1}. ${p.family || 'N/A'} | ${p.Product_Type || 'N/A'} | ${p.Product_Model || 'N/A'}`
  })
  return summaries.join('\n')
}

// Group products by family and show representative samples
function createFamilyGroupedSummary(products: ProductRecord[]): string {
  const familyGroups = new Map<string, ProductRecord[]>()
  
  // Group by family
  products.forEach(p => {
    const family = p.family || 'Unknown'
    if (!familyGroups.has(family)) {
      familyGroups.set(family, [])
    }
    familyGroups.get(family)!.push(p)
  })
  
  // Create summary with representatives from each family
  const summaries: string[] = []
  let totalShown = 0
  
  Array.from(familyGroups.entries())
    .sort((a, b) => b[1].length - a[1].length) // Sort by count
    .forEach(([family, prods]) => {
      summaries.push(`\n**${family}** (${prods.length} products):`)
      
      // Show up to 3 representatives per family
      const reps = prods.slice(0, 3)
      reps.forEach((p, i) => {
        summaries.push(`  ${i + 1}. ${p.Product_Type || 'N/A'} - ${p.Product_Model || 'N/A'} (SKU: ${p.sku || 'N/A'})`)
        totalShown++
      })
      
      if (prods.length > 3) {
        summaries.push(`  ... and ${prods.length - 3} more`)
      }
    })
  
  return summaries.join('\n')
}

// Essential product data with dynamic fields
async function prepareEssentialProductData(products: ProductRecord[], maxProducts: number = MAX_DETAILED_PRODUCTS): Promise<string> {
  const allColumns = await getDatabaseColumns()
  
  // ⬇️ Reduce priority fields to most essential
  const priorityFields = [
    'sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model',
    'Product_Description', 'Application'
  ]
  
  const essentialFields = priorityFields.filter(field => allColumns.includes(field))
  const productsToSend = products.slice(0, maxProducts)
  
  return productsToSend.map((product, index) => {
    const lines: string[] = []
    lines.push(`\n${index + 1}. ${product.family || 'N/A'} | ${product.Product_Type || 'N/A'}`)  // ⬅️ More compact header
    
    essentialFields.forEach(field => {
      if (product[field] && field !== 'family' && field !== 'Product_Type') {  // Skip already shown fields
        const value = String(product[field]).substring(0, MAX_FIELD_LENGTH)
        lines.push(`   ${field}: ${value}`)
      }
    })
    
    return lines.join('\n')
  }).join('\n')
}

// AI answer generation
async function generateAIAnswer(
  userQuery: string,
  plan: AIQueryPlan,
  products: ProductRecord[]
): Promise<{ answer: string; shouldShowComparison: boolean; comparisonProducts?: ProductRecord[] }> {
  console.log(`🤖 AI generating answer for ${products.length} products`)
  
  if (products.length === 0) {
    return {
      answer: `No products found matching: "${userQuery}".\n\n**Suggestions:**\n- Try different keywords (e.g., "basecoat" instead of "base coat")\n- Check the Product Type filter options\n- Search for specific product families or SKUs\n- Try broader terms like "primer" or "topcoat"`,
      shouldShowComparison: false
    }
  }
  
  const shortSystemPrompt = `You are an aerospace coatings expert. Answer concisely using provided data.

Format: Use markdown, **bold** for key info, tables for comparisons, dashes (-) for lists.`

  try {
    const needsDetailedAnalysis = products.length > MAX_DETAILED_PRODUCTS
    
    if (needsDetailedAnalysis) {
      console.log(`⚡ DETAILED ANALYSIS approach (${products.length} products)`)
      
      // Group products by family, type, model
      const familyGroups = new Map<string, number>()
      const typeGroups = new Map<string, number>()
      const modelGroups = new Map<string, number>()
      
      products.forEach(p => {
        const family = p.family || 'Unknown'
        const type = p.Product_Type || 'Unknown'
        const model = p.Product_Model || 'Unknown'
        
        familyGroups.set(family, (familyGroups.get(family) || 0) + 1)
        typeGroups.set(type, (typeGroups.get(type) || 0) + 1)
        modelGroups.set(model, (modelGroups.get(model) || 0) + 1)
      })
      
	// Replace the familyStats section with this:
	const familyStats = Array.from(familyGroups.entries())
	  .sort((a, b) => b[1] - a[1])
	  .map(([name, count]) => `- **${name}**: ${count} product${count > 1 ? 's' : ''}`)
	  .join('\n')  // ⬆️ Remove .slice(0, 20) to show ALL families

	const familyGroupedDetails = createFamilyGroupedSummary(products)
      
      const typeStats = Array.from(typeGroups.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `- ${name}: ${count}`)
        .join('\n')
      
      const modelStats = Array.from(modelGroups.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `- ${name}: ${count}`)
        .join('\n')
      
		console.log(`📊 Stage 1: Overview with statistics...`)

		const stage1Completion = await openai.chat.completions.create({
		  model: 'gpt-4o',
		  messages: [
			{ role: 'system', content: shortSystemPrompt },
			{
			  role: 'user',
			  content: `Question: ${userQuery}

		Total: **${products.length} products found**

		**Complete Breakdown by Family (ALL ${familyGroups.size} families):**
		${familyStats}

		**Breakdown by Type:**
		${typeStats}

		**Representative Products by Family:**
		${familyGroupedDetails}

		Provide a comprehensive overview. List ALL ${familyGroups.size} product families found. Be specific and complete.`
			}
		  ],
		  temperature: 0.3,
		  max_tokens: 1500
		})
      
      const stage1Answer = stage1Completion.choices[0].message.content || ''
      console.log(`✅ Stage 1 complete (${stage1Answer.length} chars)`)
      
		// Stage 2: Detailed examples - increase coverage
		const topProducts = products.slice(0, MAX_DETAILED_PRODUCTS)


		const essentialData = await prepareEssentialProductData(topProducts, MAX_DETAILED_PRODUCTS)

		console.log(`📊 Stage 2: Detailed examples (${topProducts.length} products)...`)

		const stage2Completion = await openai.chat.completions.create({
		  model: 'gpt-4o',
		  messages: [
			{ role: 'system', content: shortSystemPrompt + '\n\nBe concise but comprehensive. Use tables where possible.' },
			{
			  role: 'user',
			  content: `Question: ${userQuery}

		Representative products (${topProducts.length} of ${products.length} total):
		${essentialData}

		Create a detailed comparison table showing key specs. Group by family if helpful. Be comprehensive but concise.`
			}
		  ],
		  temperature: 0.3,
		  max_tokens: 2500  // ⬆️ Increase from 1800
		})
      
      const stage2Answer = stage2Completion.choices[0].message.content || ''
      console.log(`✅ Stage 2 complete (${stage2Answer.length} chars)`)
      
      // Create full product list table
      const productListTable = createProductListTable(products)
      
      // Combine everything
      const combinedAnswer = `${stage1Answer}

---

## Representative Products (Detailed)

${stage2Answer}

---

## Complete Product List (All ${products.length} Products)

${productListTable}

---

**Note:** The table above shows all ${products.length} products found. The detailed analysis covers the top ${topProducts.length} representative products.`
      
      const shouldShowComparison = plan.intent === 'comparison' && topProducts.length >= 2 && topProducts.length <= 10
      
      return {
        answer: combinedAnswer,
        shouldShowComparison,
        comparisonProducts: shouldShowComparison ? topProducts : undefined
      }
      
    } else {
      // Single-stage for small datasets
      console.log(`⚡ SINGLE-STAGE approach (${products.length} products)`)
      
      const essentialData = await prepareEssentialProductData(products)
      
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: shortSystemPrompt },
          {
            role: 'user',
            content: `Question: ${userQuery}

Products (${products.length} total):
${essentialData}

Answer comprehensively but concisely. Include all products.`
          }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })
      
      const answer = completion.choices[0].message.content || 'Unable to generate answer.'
      console.log(`✅ AI answer generated (${answer.length} chars)`)
      
      // Add full product list table
      const productListTable = createProductListTable(products)
      const finalAnswer = `${answer}

---

## Complete Product List (All ${products.length} Products)

${productListTable}`
      
      const shouldShowComparison = plan.intent === 'comparison' && products.length >= 2 && products.length <= 10
      
      return {
        answer: finalAnswer,
        shouldShowComparison,
        comparisonProducts: shouldShowComparison ? products.slice(0, 10) : undefined
      }
    }
    
  } catch (error: any) {
    console.error('❌ AI answer generation failed:', error)
    
    // Fallback: Return product list with basic stats
    const familyCounts = new Map<string, number>()
    products.forEach(p => {
      const family = p.family || 'Unknown'
      familyCounts.set(family, (familyCounts.get(family) || 0) + 1)
    })
    
    const familyList = Array.from(familyCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([family, count]) => `- ${family}: ${count} product${count > 1 ? 's' : ''}`)
      .join('\n')
    
    const productListTable = createProductListTable(products)
    
    return {
      answer: `## Search Results

Found **${products.length} products** matching your query.

### By Family:
${familyList}

---

## Complete Product List (All ${products.length} Products)

${productListTable}

---

*Note: Detailed analysis unavailable. All products are listed in the table above.*`,
      shouldShowComparison: false
    }
  }
}

// Main POST handler
export async function POST(req: NextRequest) {
  const startTime = Date.now()
  
  try {
    const body = await req.json()
    const { query, family = '', productType = '', productModel = '', forceRefresh = false } = body
    
    if (query === '__GET_FILTER_OPTIONS__') {
      console.log(`\n${'='.repeat(80)}`)
      console.log(`> 🎛️ Internal request: GET_FILTER_OPTIONS`)
      const filterOptions = await getFilterOptions(forceRefresh)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      return NextResponse.json(filterOptions)
    }
    
    console.log(`\n${'='.repeat(80)}`)
    console.log(`> 🔍 User query: ${query}`)
    console.log(`> 🎯 Applied filters: { family: '${family}', productType: '${productType}', productModel: '${productModel}' }`)
    
    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameter' },
        { status: 400 }
      )
    }
    
    const appliedFilters = { family, productType, productModel }
    const plan = await planQuery(query, appliedFilters)
    
    console.log(`> 🎯 AI determined intent: ${plan.intent}`)
    console.log(`> 🔑 Search terms: ${plan.searchTerms.join(', ')}`)
    
    const searchResults = await executeSmartSearch(plan, appliedFilters)
    console.log(`> ✅ Found ${searchResults.length} products`)
    
    const cleanedProducts = searchResults.map(p => cleanProductData(p))
    
    const { answer, shouldShowComparison, comparisonProducts } = await generateAIAnswer(
      query,
      plan,
      cleanedProducts
    )
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json({
      success: true,
      intent: plan.intent,
      summary: answer,
      products: cleanedProducts,
      count: cleanedProducts.length,
      showComparison: shouldShowComparison,
      message: `Found ${cleanedProducts.length} product(s)`,
      aiExplanation: plan.explanation,
      usedTwoStage: cleanedProducts.length > MAX_DETAILED_PRODUCTS
    })
    
  } catch (error: any) {
    console.error('> ❌ Search error:', error)
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 500 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error',
        details: error.toString()
      },
      { status: 500 }
    )
  }
}
